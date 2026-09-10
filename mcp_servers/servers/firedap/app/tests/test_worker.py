from types import SimpleNamespace

import pytest

from testforge_firedap import worker
from testforge_firedap.firmware import FLASH_START, OperationError, encode_segments


def setup_target(monkeypatch, *, device_id=0x413, flash_kib=1024, corrupt=False):
    calls=[]
    memory={}
    class FakeTarget:
        def is_locked(self):return False
        def read32(self,address):return device_id if address==0xE0042000 else 123
        def read16(self,address):return flash_kib
        def get_state(self):return 'RUNNING'
        def halt(self):calls.append('halt')
        def reset(self):calls.append('reset')
        def read_memory_block8(self,address,size):
            data=bytes(memory.get(address+i,0xFF) for i in range(size))
            return (bytes([data[0]^1])+data[1:]) if corrupt else data
    target=FakeTarget()
    class FakeSession:
        def __init__(self,probe,auto_open,options):
            self.target=target;self.probe=SimpleNamespace(wire_protocol=worker.DebugProbe.Protocol.SWD)
            calls.append(('session',options))
        def __enter__(self):return self
        def __exit__(self,*args):pass
    class FakeLoader:
        def __init__(self,session,**options):calls.append(('loader',options))
        def add_data(self,address,data):
            for i,b in enumerate(data):memory[address+i]=b
        def commit(self):calls.append('commit')
    class CmsisProbe:
        __module__='pyocd.probe.cmsis_dap_probe'
        unique_id='exact-serial'
    monkeypatch.setattr(worker.DebugProbeAggregator,'get_all_connected_probes',lambda:[CmsisProbe()])
    monkeypatch.setattr(worker,'Session',FakeSession)
    monkeypatch.setattr(worker,'FlashLoader',FakeLoader)
    return calls


def request(operation='flash'):
    return {'operation':operation,'config':{'probeSerial':'exact-serial','packPath':'pack','frequencyHz':1000000},
            'segments':encode_segments([(FLASH_START,b'abcd')]),'resetAfter':True}


def test_flash_only_sector_erase_preserves_unwritten_and_resets_after_verification(monkeypatch):
    calls=setup_target(monkeypatch)
    result=worker.execute(request())
    assert result['programmed'] and result['verified'] and result['verifiedBytes']==4
    options=next(value for key,value in [c for c in calls if isinstance(c,tuple)] if key=='session')
    assert options['auto_unlock'] is False and options['connect_mode']=='attach'
    loader=next(value for key,value in [c for c in calls if isinstance(c,tuple)] if key=='loader')
    assert loader['chip_erase']=='sector' and loader['keep_unwritten'] is True and loader['trust_crc'] is False
    assert calls[-2:]==['commit','reset']


@pytest.mark.parametrize('device_id,flash_kib',[(0x419,1024),(0x413,512)])
def test_target_mismatch_refuses_flash_before_halt(monkeypatch,device_id,flash_kib):
    calls=setup_target(monkeypatch,device_id=device_id,flash_kib=flash_kib)
    with pytest.raises(OperationError,match='Target mismatch'):
        worker.execute(request())
    assert 'halt' not in calls and 'commit' not in calls


def test_verification_failure_does_not_boot_unverified_program(monkeypatch):
    calls=setup_target(monkeypatch,corrupt=True)
    with pytest.raises(OperationError,match='mismatch'):
        worker.execute(request())
    assert 'reset' not in calls


def test_identity_inspection_does_not_halt_reset_or_program(monkeypatch):
    calls=setup_target(monkeypatch)
    assert worker.execute(request('target_info'))['coreState']=='RUNNING'
    assert len(calls)==1


def test_serial_is_exact_not_a_substring_match(monkeypatch):
    calls=setup_target(monkeypatch)
    req=request();req['config']['probeSerial']='serial'
    with pytest.raises(OperationError,match='not connected'):
        worker.execute(req)
    assert calls==[]
