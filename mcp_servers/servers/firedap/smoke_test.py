"""Exercise the running authenticated MCP service. Optional --target-info only reads identity.

Never programs, resets, or erases a target. Firmware writes are covered by unit tests,
and require a user-selected image for a real bench test.
"""
import argparse
import asyncio
import json
from pathlib import Path

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def run(target_info: bool):
    config = json.loads((Path(__file__).parent/'server.json').read_text(encoding='utf-8-sig'))
    url=f"http://127.0.0.1:{config['port']}"
    report={}
    async with httpx.AsyncClient() as unauthenticated:
        assert (await unauthenticated.post(url+'/mcp',json={})).status_code==401
    report['unauthenticatedRejected']=True
    async with httpx.AsyncClient(headers={'Authorization':'Bearer '+config['token']}) as http:
        async with streamable_http_client(url+'/mcp',http_client=http) as (read,write,_):
            async with ClientSession(read,write) as session:
                await session.initialize()
                tools=(await session.list_tools()).tools
                report['toolCount']=len(tools)
                assert all(t.outputSchema is not None for t in tools)
                for tool in tools:
                    if (tool.meta or {}).get('hardwareharness',{}).get('kind')=='hardware':
                        assert 'hardwareId' in tool.inputSchema['required']
                async def call(name,args=None,meta=None):
                    result=await session.call_tool(name,args or {},meta=meta)
                    assert not result.isError,result.content
                    assert result.structuredContent is not None,'Missing structuredContent'
                    return result.structuredContent
                hardware=(await call('list_hardware'))['data']
                assert len(hardware)==1 and hardware[0]['hardwareId']==config['hardwareId']
                report['hardware']=hardware
                board=(await call('firedap_get_board_reference'))['data']
                assert len(board['ports'])==14
                report['boardPorts']=len(board['ports'])
                if target_info:
                    started = await call('firedap_target_info', {'hardwareId': config['hardwareId']})
                    assert started['ok'], started
                    job = started['data']
                    for _ in range(130):
                        await asyncio.sleep(1)
                        job = (await call('firedap_get_job', {'job_id': job['jobId']}))['data']
                        if job['state'] != 'running':
                            break
                    report['targetInfo'] = job
                    assert job['state'] != 'running', 'Target job exceeded its deadline'
    destination=Path(__file__).parent/'run/smoke-test.json'
    destination.parent.mkdir(exist_ok=True)
    destination.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
    if target_info and report.get('targetInfo',{}).get('state')!='succeeded':
        raise SystemExit(2)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--target-info',action='store_true')
    asyncio.run(run(parser.parse_args().target_info))
