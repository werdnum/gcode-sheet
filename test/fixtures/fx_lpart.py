#!/usr/bin/env python3
"""Regenerate the fx_lpart_{far,near} fixtures: a white L (slab plus upright) with a raised
inscription that is a second part of the SAME object on extruder 2 (single-extruder multi
material, M600 tool change). Writes the two .3mf files, then slice each with PrusaSlicer 2.9:

  nix shell nixpkgs#prusa-slicer --command prusa-slicer --load bench/mk4.ini \\
    --nozzle-diameter 0.4,0.4 --single-extruder-multi-material --no-wipe-tower \\
    --toolchange-gcode M600 --gcode-label-objects octoprint --extruder-colour '#FFFFFF;#000000' \\
    --filament-diameter 1.75,1.75 --temperature 215,215 --first-layer-temperature 215,215 \\
    --before-layer-gcode 'G92 E0' --perimeters 2 --top-solid-layers 2 --bottom-solid-layers 2 \\
    --fill-density 10% --layer-height 0.3 --first-layer-height 0.3 --dont-arrange \\
    --export-gcode --output test/fixtures/fx_lpart_far.gcode fx_lpart_far.3mf
"""
import sys, zipfile
def box(x0,y0,z0,x1,y1,z1):
    v=[(x0,y0,z0),(x1,y0,z0),(x1,y1,z0),(x0,y1,z0),(x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)]
    t=[(0,2,1),(0,3,2),(4,5,6),(4,6,7),(0,1,5),(0,5,4),(1,2,6),(1,6,5),(2,3,7),(2,7,6),(3,0,4),(3,4,7)]
    return v,t
def make(path, upright):
    vols=[("slab",1,box(0,0,0,40,120,5)),("upright",1,box(*upright)),("text",2,box(10,6,5,30,14,7))]
    verts=[];tris=[];ranges=[]
    for name,ext,(v,t) in vols:
        base=len(verts); first=len(tris)
        verts+=v; tris+=[(a+base,b+base,c+base) for a,b,c in t]
        ranges.append((name,ext,first,len(tris)-1))
    vx="".join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for x,y,z in verts)
    tx="".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a,b,c in tris)
    model=f'''<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">
<metadata name="slic3rpe:Version3mf">1</metadata>
<resources><object id="1" type="model"><mesh><vertices>{vx}</vertices><triangles>{tx}</triangles></mesh></object></resources>
<build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 105 45 0" printable="1"/></build>
</model>'''
    vol="".join(f'<volume firstid="{f}" lastid="{l}"><metadata type="volume" key="name" value="{n}"/><metadata type="volume" key="extruder" value="{e}"/></volume>' for n,e,f,l in ranges)
    cfg=f'''<?xml version="1.0" encoding="UTF-8"?>
<config><object id="1" instances_count="1"><metadata type="object" key="name" value="lpart"/><metadata type="object" key="extruder" value="1"/>{vol}</object></config>'''
    ct='''<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'''
    rels='''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'''
    with zipfile.ZipFile(path,'w') as z:
        z.writestr('[Content_Types].xml',ct); z.writestr('_rels/.rels',rels)
        z.writestr('3D/3dmodel.model',model); z.writestr('Metadata/Slic3r_PE_model.config',cfg)
make('fx_lpart_far.3mf',(5,105,5,35,115,30))
make('fx_lpart_near.3mf',(5,22,5,35,30,30))
