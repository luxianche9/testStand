import asyncio
import hashlib
import time

import pytest

from hardwareharness_firedap.firmware import FLASH_START, OperationError
from hardwareharness_firedap.runtime import Runtime
from hardwareharness_firedap.worker import verify_bytes


def config(tmp_path):
    return {'hardwareId':'DAP','serverId':'DAP_MCP','computerId':'LOCAL','probeSerial':'serial',
            'packPath':'pack','frequencyHz':1000000,'firmwareRoots':[str(tmp_path)],'jobDirectory':str(tmp_path/'jobs')}


def test_lease_is_required_and_wrong_hardware_is_rejected(tmp_path):
    async def run():
        r=Runtime(config(tmp_path))
        with pytest.raises(OperationError,match='occupancy'):
            await r.start_job('DAP',None,'target_info')
        with pytest.raises(OperationError,match='Unknown hardwareId'):
            await r.start_job('wrong','lease','target_info')
        await r.occupancy('DAP','acquire','holder','Holder','lease')
        with pytest.raises(OperationError,match='occupied'):
            await r.occupancy('DAP','acquire','other','Other','other')
        r.lease['deadline']=time.monotonic()-1
        with pytest.raises(OperationError,match='occupancy'):
            await r.start_job('DAP','lease','target_info')
    asyncio.run(run())


def test_busy_job_keeps_heartbeats_responsive_and_prevents_takeover_or_shutdown(tmp_path):
    async def run():
        finish=asyncio.Event()
        async def worker(request,timeout):
            await finish.wait()
            return {'verified':True,'verifiedBytes':4}
        r=Runtime(config(tmp_path),worker)
        await r.occupancy('DAP','acquire','holder','Holder','lease')
        path=tmp_path/'firmware.bin';path.write_bytes(b'1234')
        job=await r.start_job('DAP','lease','flash',str(path),FLASH_START,hashlib.sha256(b'1234').hexdigest())
        assert job['state']=='running'
        r.lease['deadline']=time.monotonic()-1
        with pytest.raises(OperationError,match='occupied'):
            await r.occupancy('DAP','acquire','other','Other','other')
        assert (await r.occupancy('DAP','heartbeat','holder',lease_id='lease'))['state']=='occupied'
        assert r.lease['deadline']>time.monotonic()
        with pytest.raises(OperationError,match='Wait'):
            await r.occupancy('DAP','release','holder',lease_id='lease')
        with pytest.raises(OperationError,match='shutdown refused'):
            await r.shutdown()
        with pytest.raises(OperationError,match='already running'):
            await r.start_job('DAP','lease','target_info')
        finish.set(); await r.task
        assert r.get_job(job['jobId'])['state']=='succeeded'
        assert (tmp_path/'jobs'/f"{job['jobId']}.json").is_file()
        assert (await r.occupancy('DAP','release','holder',lease_id='lease'))['state']=='unoccupied'
        assert (await r.shutdown())['safe']
    asyncio.run(run())


def test_worker_failure_remains_failure_not_programming_success(tmp_path):
    async def run():
        async def worker(request,timeout):
            raise OperationError('read-back mismatch','verification_failed')
        r=Runtime(config(tmp_path),worker)
        await r.occupancy('DAP','acquire','holder','Holder','lease')
        job=await r.start_job('DAP','lease','target_info')
        await r.task
        assert r.get_job(job['jobId'])['state']=='failed'
        assert r.hardware()['state']=='faulted'
        assert r.get_job(job['jobId'])['error']['category']=='verification_failed'
    asyncio.run(run())


def test_byte_verification_detects_actual_readback_corruption():
    class Target:
        def read_memory_block8(self,address,size):return b'abcd'[:size]
    assert verify_bytes(Target(),[(FLASH_START,b'abcd')])==4
    with pytest.raises(OperationError,match='0x8000002'):
        verify_bytes(Target(),[(FLASH_START,b'abXd')])


def test_sram_read_dispatches_with_lease_and_rejects_bad_range_before_worker(tmp_path):
    async def run():
        requests=[]
        async def worker(request,timeout):
            requests.append(request)
            return {'address':request['readAddress'],'length':request['readLength'],'words':[1,2]}
        runtime=Runtime(config(tmp_path),worker)
        with pytest.raises(OperationError,match='occupancy'):
            await runtime.start_job('DAP',None,'read_sram',read_address=0x20000000,read_length=8)
        await runtime.occupancy('DAP','acquire','holder','Holder','lease')
        with pytest.raises(OperationError):
            await runtime.start_job('DAP','lease','read_sram',read_address=0x40000000,read_length=8)
        assert requests==[]
        job=await runtime.start_job('DAP','lease','read_sram',read_address=0x20000000,read_length=8)
        await runtime.task
        assert runtime.get_job(job['jobId'])['state']=='succeeded'
        assert runtime.get_job(job['jobId'])['result']['words']==[1,2]
        assert len(requests)==1
        assert requests[0]['operation']=='read_sram'
        assert requests[0]['readAddress']==0x20000000
        assert requests[0]['readLength']==8
    asyncio.run(run())
