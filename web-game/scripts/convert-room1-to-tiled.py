#!/usr/bin/env python3
"""
Convert Sunnyside's GameMaker Room1.yy example map to Tiled JSON format.
Output: web-game/assets/maps/seaside-town.json

The Room1 example is a beautifully hand-crafted map by the asset author.
We convert it once, then use Tiled editor for further customization.
"""
import json
import os
import re
import sys

ROOM_YY = os.path.expanduser("~/Downloads/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Gamemaker/rooms/Room1/Room1.yy")
OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "maps", "seaside-town.json")

# GameMaker constants
GM_INT_MIN = -2147483648
GM_FLIP_H = 0x10000000
GM_FLIP_V = 0x20000000
GM_ROT_90 = 0x40000000
GM_TILE_MASK = 0x0FFFFFFF

# Tiled constants
TILED_FLIP_H = 0x80000000
TILED_FLIP_V = 0x40000000
TILED_FLIP_D = 0x20000000  # diagonal (= rotation)

FIRST_GID = 1


def decode_gm(compressed):
    """GM RLE: negative N => -N copies of next; positive N => N literal values follow."""
    tiles = []
    i = 0
    n = len(compressed)
    while i < n:
        v = compressed[i]
        i += 1
        if v < 0:
            run_len = -v
            if i < n:
                tile_v = compressed[i]
                i += 1
                tiles.extend([tile_v] * run_len)
        elif v > 0:
            for _ in range(v):
                if i < n:
                    tiles.append(compressed[i])
                    i += 1
        else:
            tiles.append(0)
    return tiles


def gm_tile_to_tiled(gm_val):
    """Convert a GameMaker tile value (with flip bits) to a Tiled gid."""
    if gm_val == GM_INT_MIN or gm_val == 0:
        return 0
    raw = gm_val & GM_TILE_MASK
    if raw == 0:
        return 0
    # Map GM flip bits to Tiled flip bits
    flags = 0
    if gm_val & GM_FLIP_H:
        flags |= TILED_FLIP_H
    if gm_val & GM_FLIP_V:
        flags |= TILED_FLIP_V
    if gm_val & GM_ROT_90:
        flags |= TILED_FLIP_D
    return (raw + FIRST_GID) | flags


def main():
    with open(ROOM_YY) as f:
        text = f.read()
    text = re.sub(r',(\s*[}\]])', r'\1', text)
    room = json.loads(text)

    # Find canonical width/height (most layers use 86x48)
    W, H = 86, 48
    for layer in room['layers']:
        if layer.get('resourceType') == 'GMRTileLayer':
            td = layer.get('tiles', {})
            if td.get('SerialiseWidth') == 86:
                W = td['SerialiseWidth']
                H = td['SerialiseHeight']
                break

    # Process tile layers in render order (back to front)
    # GM depth: higher = further back; sort descending so background first
    tile_layers = [l for l in room['layers'] if l.get('resourceType') == 'GMRTileLayer']
    tile_layers.sort(key=lambda l: -l.get('depth', 0))

    out_layers = []
    layer_id = 1
    for gm_layer in tile_layers:
        td = gm_layer.get('tiles', {})
        cd = td.get('TileCompressedData')
        if not cd:
            continue
        lw = td['SerialiseWidth']
        lh = td['SerialiseHeight']
        decoded_gm = decode_gm(cd)
        # Truncate or pad to lw*lh
        if len(decoded_gm) > lw * lh:
            decoded_gm = decoded_gm[:lw * lh]
        while len(decoded_gm) < lw * lh:
            decoded_gm.append(GM_INT_MIN)

        # Convert to Tiled gids
        tiled_data = [gm_tile_to_tiled(v) for v in decoded_gm]

        # If layer is smaller than canonical, pad to W×H (use 0)
        if lw != W or lh != H:
            new_data = [0] * (W * H)
            for y in range(min(lh, H)):
                for x in range(min(lw, W)):
                    new_data[y * W + x] = tiled_data[y * lw + x]
            tiled_data = new_data

        # Skip empty layers
        if all(t == 0 for t in tiled_data):
            continue

        out_layers.append({
            "data": tiled_data,
            "height": H,
            "id": layer_id,
            "name": gm_layer['name'],
            "opacity": 1.0,
            "type": "tilelayer",
            "visible": True,
            "width": W,
            "x": 0,
            "y": 0,
        })
        layer_id += 1

    # Add an empty Collisions layer for user to fill in via Tiled
    out_layers.append({
        "data": [0] * (W * H),
        "height": H,
        "id": layer_id,
        "name": "Collisions",
        "opacity": 0.4,
        "type": "tilelayer",
        "visible": False,
        "width": W,
        "x": 0,
        "y": 0,
    })
    layer_id += 1

    # === Anima location markers ===
    # Place locations at sensible spots within the 86x48 map
    # User can adjust in Tiled later
    LOCATIONS = {
        "forest":       {"x": 8,  "y": 8,  "label": "森林"},
        "farm":         {"x": 70, "y": 8,  "label": "农场"},
        "home_tomori":  {"x": 12, "y": 18, "label": "灯の家"},
        "home_anon":    {"x": 22, "y": 18, "label": "爱音の家"},
        "home_sakiko":  {"x": 35, "y": 18, "label": "祥子の家"},
        "home_mutsumi": {"x": 50, "y": 18, "label": "睦の家"},
        "home_soyo":    {"x": 65, "y": 18, "label": "素世の家"},
        "library":      {"x": 10, "y": 28, "label": "图书馆"},
        "flower_shop":  {"x": 25, "y": 28, "label": "花店"},
        "bakery":       {"x": 38, "y": 28, "label": "面包坊"},
        "cafe":         {"x": 50, "y": 28, "label": "咖啡馆"},
        "shop":         {"x": 68, "y": 28, "label": "杂货店"},
        "bar":          {"x": 68, "y": 36, "label": "酒吧"},
        "plaza":        {"x": 40, "y": 36, "label": "广场"},
        "beach":        {"x": 30, "y": 42, "label": "沙滩"},
        "dock":         {"x": 65, "y": 42, "label": "码头"},
    }

    # Tileset entries
    tilesets = [
        {
            "columns": 64,
            "firstgid": FIRST_GID,
            "image": "../sunnyside/Tileset/spr_tileset_sunnysideworld_16px.png",
            "imageheight": 1024,
            "imagewidth": 1024,
            "margin": 0,
            "name": "sunnysideworld",
            "spacing": 0,
            "tilecount": 4096,
            "tileheight": 16,
            "tilewidth": 16,
        },
    ]

    tiled_map = {
        "compressionlevel": -1,
        "height": H,
        "infinite": False,
        "layers": out_layers,
        "nextlayerid": layer_id,
        "nextobjectid": 1,
        "orientation": "orthogonal",
        "renderorder": "right-down",
        "tiledversion": "1.10.2",
        "tileheight": 16,
        "tilesets": tilesets,
        "tilewidth": 16,
        "type": "map",
        "version": "1.10",
        "width": W,
        "properties": [
            {"name": "locations", "type": "string", "value": json.dumps(LOCATIONS, ensure_ascii=False)}
        ],
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(tiled_map, f, indent=2, ensure_ascii=False)

    print(f"Wrote {OUT}")
    print(f"Map: {W}x{H} tiles ({W*16}x{H*16} px)")
    print(f"Layers: {len(out_layers)}")
    for l in out_layers:
        nz = sum(1 for t in l['data'] if t != 0)
        print(f"  {l['name']}: {nz} tiles")


if __name__ == "__main__":
    main()
