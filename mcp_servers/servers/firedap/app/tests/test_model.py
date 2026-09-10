import json
import re
import zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[4]/'hardware-manuals'/'stm32-batianhu-v2'


def test_common_scope_pin_uniqueness_and_all_110_exposed_gpio():
    hardware=json.loads((ROOT/'hardware.json').read_text(encoding='utf8'))
    model=json.loads((ROOT/'model.json').read_text(encoding='utf8'))
    assert len(hardware['ports'])==14
    assert sum(len(p['pins']) for p in hardware['ports'])==197
    ids=[s['pinId'] for p in hardware['ports'] for s in p['pins']]
    assert len(ids)==len(set(ids))
    gpio=[pin['label'] for port in hardware['ports'] if port['portId'] in ['DUT_1.CN2','DUT_1.CN3']
          for pin in port['pins'] if re.fullmatch('P[A-I][0-9]+',pin['label'])]
    assert len(gpio)==len(set(gpio))==110
    assert not {'J17','CN6','J19','J20','J22','J54','J28'} & {p['ref'] for p in model['ports']}
    assert len([c for c in model['boardConfigurations'] if c['ref']=='BOOT'])==1
    assert not {'J63','J64','J65'} & {c['ref'] for c in model['boardConfigurations']}


def test_swd_can_rs485_and_header_ground_positions_from_schematic():
    hardware=json.loads((ROOT/'hardware.json').read_text(encoding='utf8'))
    ports={p['portId']:p for p in hardware['ports']}
    assert [s['label'] for s in ports['DUT_1.J1']['pins']]==['3V3','PA13/SWDIO','GND','PA14/SWCLK','NRST']
    assert [s['label'] for s in ports['J1']['pins']]==['CANL','CANH']
    assert [s['label'] for s in ports['251574e3-45eb-4ccd-9a0d-be332ee3ac06.J1']['pins']]==['485A','485B']
    assert ports['DUT_1.CN2']['pins'][7]['label']=='GND'
    assert ports['DUT_1.CN3']['pins'][45]['label']=='GND'
    assert ports['DUT_1.CN3']['pins'][46]['label']=='PD6'


def test_bundle_manifest_and_images_are_self_contained():
    with zipfile.ZipFile(ROOT/'stm32-batianhu-v2.tfhw') as archive:
        manifest=json.loads(archive.read('bundle.json'))
        hardware=json.loads(archive.read('hardware.json'))
        assert manifest=={'formatVersion':2,'kind':'hardware','id':hardware['hardwareId']}
        for asset in [hardware['appearanceAssetId'],*[p['imageAssetId'] for p in hardware['ports']]]:
            assert archive.read(asset).startswith(b'\x89PNG\r\n\x1a\n')
