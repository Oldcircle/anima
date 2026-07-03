extends Node2D
## Ninja Adventure 像素小镇（P1b 真美术，日式 RPG 风）。
##
## 地形 = TileMapLayer（草地/沙滩/海/土路），建筑与树木 = 图集区域 Sprite2D（y-sort）。
## 职责与旧版一致：build() 摆世界、zone_center()/slot() 给角色定位、demo_locations() 离线演示。
## 夜景灯光（窗光/灯笼辉光）放进外部传入的 lights_parent —— 它不吃夜色 modulate，负责"亮"。
## 素材：assets/ninja_adventure（CC0，见目录内 README.md）。

const TILE := 16
const MAP_W := 40
const MAP_H := 23

const TS_DIR := "res://assets/ninja_adventure/tilesets/"

# ---- TilesetField：草地基底 + 沙滩 blob（叠草地上）----
const GRASS_C := Vector2i(1, 4)
const SAND_T := Vector2i(1, 0)
const SAND_C := Vector2i(1, 1)

# ---- TilesetWater：海面（沙基水块 cols 4..7）+ 码头板 + 水面点缀 ----
const WATER_T := [Vector2i(5, 0), Vector2i(6, 0)]
const WATER_C := [Vector2i(5, 1), Vector2i(6, 1), Vector2i(5, 2), Vector2i(6, 2)]
const WATER_FISH := Vector2i(11, 1)
const WATER_LILY := Vector2i(11, 3)
# 码头：cols 0..2 带边框的 3 宽木板，rows 12..15 从岸到端头
const DOCK_ROWS := [12, 13, 14, 15]

# ---- TilesetFloor：草地上的土路 blob（rows 7..13）----
const P_TL := Vector2i(0, 7)
const P_T := Vector2i(1, 7)
const P_TR := Vector2i(2, 7)
const P_L := Vector2i(0, 8)
const P_C := Vector2i(1, 8)
const P_R := Vector2i(2, 8)
const P_BL := Vector2i(0, 9)
const P_B := Vector2i(1, 9)
const P_BR := Vector2i(2, 9)
const PV_T := Vector2i(3, 7)
const PV_M := Vector2i(3, 8)
const PV_B := Vector2i(3, 9)
const PH_L := Vector2i(0, 10)
const PH_M := Vector2i(1, 10)
const PH_R := Vector2i(2, 10)

# ---- TilesetFloorDetail：草丛/小花点缀 ----
const DECO_TUFTS := [Vector2i(0, 2), Vector2i(1, 2), Vector2i(2, 2), Vector2i(3, 2)]
const DECO_FLOWER := Vector2i(5, 2)

# ---- 图集区域图章（tex, tile_x, tile_y, w, h）----
const R_HOME_A := ["TilesetHouse", 0, 0, 4, 3]      # 橙茅草顶民居
const R_HOME_B := ["TilesetHouse", 8, 0, 4, 3]      # 橙瓦顶民居
const R_HOUSE_BEIGE := ["TilesetHouse", 4, 0, 4, 3] # 米色墙民居
const R_INN := ["TilesetHouse", 26, 0, 3, 3]        # 二层木旅馆
const R_BAR := ["TilesetHouse", 12, 0, 4, 3]        # 红瓦居酒屋
const R_CAFE := ["TilesetHouse", 16, 0, 3, 3]       # 蓝顶拉面店（带碗招牌）
const R_SHOP := ["TilesetHouse", 19, 0, 3, 3]       # 杂货铺（带菜摊）
const R_BAKERY := ["TilesetHouse", 22, 0, 3, 3]     # 圆顶点心铺
const R_LIBRARY := ["TilesetHouse", 25, 10, 4, 4]   # 大茅草顶（最大建筑）
const R_TORII := ["TilesetHouse", 0, 5, 3, 2]       # 红鸟居
const R_PILLAR := ["TilesetHouse", 0, 15, 1, 2]     # 石柱灯
const R_PINE_BIG := ["TilesetNature", 0, 2, 4, 3]
const R_ROUND_BIG := ["TilesetNature", 4, 2, 2, 3]
const R_WHITE_BIG := ["TilesetNature", 8, 2, 4, 3]
const R_SAKURA := ["TilesetNature", 12, 2, 4, 3]
const R_GREEN_WIDE := ["TilesetNature", 16, 2, 4, 3]
const R_TREE_S := ["TilesetNature", 0, 0, 2, 2]
const R_PINE_S := ["TilesetNature", 2, 0, 2, 2]
const R_ROCK := ["TilesetNature", 12, 7, 2, 2]
const R_BUSH := ["TilesetNature", 0, 10, 1, 1]
const R_BUSH2 := ["TilesetNature", 2, 10, 1, 1]
const R_SUNFLOWER := ["TilesetNature", 0, 11, 1, 1]
const R_FLOWER_R := ["TilesetNature", 3, 11, 1, 1]
const R_STONES := ["TilesetFloorDetail", 9, 0, 1, 1]
const R_HAY := ["TilesetElement", 13, 4, 3, 3]      # 干草田块
const R_BALE := ["TilesetElement", 12, 4, 1, 2]     # 干草垛
const R_CART := ["TilesetElement", 0, 3, 2, 2]      # 木推车
const R_BOAT := ["TilesetWater", 26, 0, 2, 2]       # 小船

# ---- 地点布局（tile 坐标）----
# bldg = 建筑股票 + 左上角 tile；stand = 角色聚集点；label = 牌子文字位置（默认建筑上方）
const LAYOUT := {
	"forest":            {"stand": Vector2i(3, 5)},
	"farm":              {"stand": Vector2i(11, 6)},
	"library":           {"bldg": R_LIBRARY, "at": Vector2i(15, 1), "stand": Vector2i(17, 6)},
	"flower_shop":       {"bldg": R_HOUSE_BEIGE, "at": Vector2i(21, 2), "stand": Vector2i(23, 6)},
	"bakery":            {"bldg": R_BAKERY, "at": Vector2i(2, 9), "stand": Vector2i(3, 12)},
	"plaza":             {"stand": Vector2i(14, 11)},
	"cafe":              {"bldg": R_CAFE, "at": Vector2i(20, 9), "stand": Vector2i(21, 12)},
	"shop":              {"bldg": R_SHOP, "at": Vector2i(2, 14), "stand": Vector2i(3, 17)},
	"bar":               {"bldg": R_BAR, "at": Vector2i(20, 14), "stand": Vector2i(21, 17)},
	"beach":             {"stand": Vector2i(8, 19)},
	"dock":              {"stand": Vector2i(25, 20)},
	"home_asuka":        {"bldg": R_HOME_A, "at": Vector2i(30, 1), "stand": Vector2i(32, 4)},
	"home_l":            {"bldg": R_INN, "at": Vector2i(36, 1), "stand": Vector2i(37, 4)},
	"home_lelouch":      {"bldg": R_HOME_B, "at": Vector2i(30, 5), "stand": Vector2i(32, 8)},
	"home_light":        {"bldg": R_HOUSE_BEIGE, "at": Vector2i(36, 5), "stand": Vector2i(38, 8)},
	"home_rei":          {"bldg": R_HOME_A, "at": Vector2i(30, 9), "stand": Vector2i(32, 12)},
	"home_senjougahara": {"bldg": R_HOME_B, "at": Vector2i(36, 9), "stand": Vector2i(38, 12)},
	"home_shinji":       {"bldg": R_HOUSE_BEIGE, "at": Vector2i(30, 13), "stand": Vector2i(32, 16)},
}

const NAME_BY_ID := {
	"bakery": "海风面包坊", "bar": "酒吧", "beach": "海边", "cafe": "咖啡馆",
	"dock": "码头", "farm": "农田", "flower_shop": "潮声花店", "forest": "森林",
	"library": "图书馆", "plaza": "广场", "shop": "杂货店",
	"home_asuka": "明日香的公寓", "home_l": "L的旅馆房间", "home_lelouch": "鲁鲁修的住所",
	"home_light": "月的住所", "home_rei": "绫波丽的房间",
	"home_senjougahara": "战场原的家", "home_shinji": "真嗣的小屋",
}

const TYPE_BY_ID := {
	"bakery": "commercial", "bar": "commercial", "cafe": "commercial",
	"shop": "commercial", "flower_shop": "commercial",
	"library": "public", "plaza": "public",
	"beach": "nature", "dock": "nature", "farm": "nature", "forest": "nature",
}

const BEACH_Y := 17       # 沙滩带起始行（含过渡行）
const WATER_Y := 20       # 海面起始行
const DOCK_X := 24        # 码头左缘（3 宽）

var _zone_pos := {}       # id -> 站点像素坐标
var _textures := {}       # 名称 -> Texture2D 缓存
var _objects: Node2D      # y-sort 的建筑/树木层
var _labels: Node2D       # 地点牌子（最上层）
var _fallback_i := 0
var _rng := RandomNumberGenerator.new()

func type_for(id: String, fallback: String = "public") -> String:
	if id.begins_with("home_"):
		return "residential"
	return TYPE_BY_ID.get(id, fallback)

func name_for(id: String) -> String:
	return NAME_BY_ID.get(id, id)

func demo_locations() -> Array:
	var out := []
	for id in LAYOUT:
		out.append({"id": id, "name": name_for(id), "type": type_for(id)})
	return out

## lights_parent：夜景灯光挂到它下面（Main 保证它不吃夜色染色）
func build(locations: Array, lights_parent: Node2D) -> void:
	_rng.seed = 20260703   # 点缀布置固定，避免每次连接地图变样
	_build_ground()
	_build_paths()
	_objects = Node2D.new()
	_objects.name = "Objects"
	_objects.y_sort_enabled = true
	add_child(_objects)
	_labels = Node2D.new()
	_labels.name = "Labels"
	_labels.z_index = 10
	add_child(_labels)
	_build_nature()
	for loc in locations:
		var id: String = str(loc.get("id", ""))
		if id == "":
			continue
		var conf: Dictionary = LAYOUT.get(id, {})
		var stand: Vector2i = conf["stand"] if conf.has("stand") else _fallback_stand()
		if conf.has("bldg"):
			var at: Vector2i = conf["at"]
			_stamp_at(conf["bldg"], at)
			_add_door_glow(conf["bldg"], at, lights_parent)
			_add_label(name_for(id) if NAME_BY_ID.has(id) else str(loc.get("name", id)),
				Vector2((at.x + conf["bldg"][3] / 2.0) * TILE, at.y * TILE - 4))
		else:
			_add_label(name_for(id) if NAME_BY_ID.has(id) else str(loc.get("name", id)),
				Vector2((stand.x + 0.5) * TILE, (stand.y - 1.6) * TILE))
		_zone_pos[id] = Vector2((stand.x + 0.5) * TILE, (stand.y + 0.5) * TILE)
	_build_plaza_props(lights_parent)
	_add_glow(Vector2((DOCK_X + 1.5) * TILE, (WATER_Y + 0.5) * TILE), 60.0, Color("9fd0ff"), lights_parent)
	print("[Town] 已布局 %d 个地点（Ninja Adventure 像素小镇 %dx%d）" % [_zone_pos.size(), MAP_W, MAP_H])

# ---------------- 地形 ----------------

func _tex(name: String) -> Texture2D:
	if not _textures.has(name):
		_textures[name] = load(TS_DIR + name + ".png")
	return _textures[name]

func _layer(tex_name: String) -> TileMapLayer:
	var layer := TileMapLayer.new()
	var ts := TileSet.new()
	ts.tile_size = Vector2i(TILE, TILE)
	var src := TileSetAtlasSource.new()
	src.texture = _tex(tex_name)
	src.texture_region_size = Vector2i(TILE, TILE)
	var cols := int(src.texture.get_width() / float(TILE))
	var rows := int(src.texture.get_height() / float(TILE))
	for y in rows:
		for x in cols:
			src.create_tile(Vector2i(x, y))
	ts.add_source(src, 0)
	layer.tile_set = ts
	add_child(layer)
	return layer

func _build_ground() -> void:
	var grass := _layer("TilesetField")
	grass.name = "Grass"
	for y in MAP_H:
		for x in MAP_W:
			grass.set_cell(Vector2i(x, y), 0, GRASS_C)

	var sand := _layer("TilesetField")
	sand.name = "Sand"
	for x in MAP_W:
		sand.set_cell(Vector2i(x, BEACH_Y), 0, SAND_T)
		for y in range(BEACH_Y + 1, MAP_H):
			sand.set_cell(Vector2i(x, y), 0, SAND_C)

	var water := _layer("TilesetWater")
	water.name = "Water"
	for x in MAP_W:
		water.set_cell(Vector2i(x, WATER_Y), 0, WATER_T[x % 2])
		for y in range(WATER_Y + 1, MAP_H):
			water.set_cell(Vector2i(x, y), 0, WATER_C[(x + y) % 4])
	# 水面点缀：鱼影 / 莲叶
	for spot in [[3, 21, WATER_FISH], [11, 22, WATER_LILY], [17, 21, WATER_FISH], [33, 22, WATER_FISH], [37, 21, WATER_LILY]]:
		water.set_cell(Vector2i(spot[0], spot[1]), 0, spot[2])

	# 码头：3 宽木板从沙滩伸进海里
	var dock := _layer("TilesetWater")
	dock.name = "Dock"
	for i in 4:
		for dx in 3:
			dock.set_cell(Vector2i(DOCK_X + dx, 19 + i), 0, Vector2i(dx, DOCK_ROWS[i]))

func _build_paths() -> void:
	var path := _layer("TilesetFloor")
	path.name = "Paths"
	var cells := {}   # Vector2i -> "h" | "v" | "x"

	var mark := func(c: Vector2i, kind: String) -> void:
		if cells.has(c) and cells[c] != kind:
			cells[c] = "x"
		else:
			cells[c] = kind

	# 主街（东西向，穿过广场）
	for x in range(1, 39):
		mark.call(Vector2i(x, 12), "h")
	# 中轴（图书馆→广场→海滩）
	for y in range(6, 18):
		mark.call(Vector2i(13, y), "v")
	# 住宅区纵路 + 门前横路
	for y in range(3, 17):
		mark.call(Vector2i(34, y), "v")
	for x in range(32, 38):
		mark.call(Vector2i(x, 4), "h")
	for x in range(32, 39):
		mark.call(Vector2i(x, 8), "h")
	for x in range(32, 35):
		mark.call(Vector2i(x, 16), "h")
	# 支路：农田 / 图书馆 / 花店 / 酒吧 / 杂货店
	for y in range(6, 9):
		mark.call(Vector2i(11, y), "v")
	for y in range(5, 12):
		mark.call(Vector2i(17, y), "v")
	for y in range(6, 12):
		mark.call(Vector2i(23, y), "v")
	for y in range(13, 18):
		mark.call(Vector2i(21, y), "v")
	for y in range(13, 18):
		mark.call(Vector2i(3, y), "v")

	# 广场：大块土地 blob（x10..17, y9..14）
	var pz := Rect2i(10, 9, 8, 6)
	for y in range(pz.position.y, pz.end.y):
		for x in range(pz.position.x, pz.end.x):
			var t := P_C
			var left := x == pz.position.x
			var right := x == pz.end.x - 1
			var top := y == pz.position.y
			var bottom := y == pz.end.y - 1
			if top and left: t = P_TL
			elif top and right: t = P_TR
			elif bottom and left: t = P_BL
			elif bottom and right: t = P_BR
			elif top: t = P_T
			elif bottom: t = P_B
			elif left: t = P_L
			elif right: t = P_R
			path.set_cell(Vector2i(x, y), 0, t)
			cells.erase(Vector2i(x, y))

	for c: Vector2i in cells:
		if c.y >= BEACH_Y:   # 路不画到沙滩上
			continue
		var kind: String = cells[c]
		var t := P_C
		if kind == "h":
			t = PH_M
			if not cells.has(c + Vector2i.LEFT) and not _in_plaza(c + Vector2i.LEFT): t = PH_L
			elif not cells.has(c + Vector2i.RIGHT) and not _in_plaza(c + Vector2i.RIGHT): t = PH_R
		elif kind == "v":
			t = PV_M
			if not cells.has(c + Vector2i.UP) and not _in_plaza(c + Vector2i.UP): t = PV_T
			elif not cells.has(c + Vector2i.DOWN) and not _in_plaza(c + Vector2i.DOWN): t = PV_B
		path.set_cell(c, 0, t)

	# 草地点缀：草丛/野花（避开路和沙滩）
	var deco := _layer("TilesetFloorDetail")
	deco.name = "Deco"
	for i in 70:
		var c := Vector2i(_rng.randi_range(0, MAP_W - 1), _rng.randi_range(0, BEACH_Y - 1))
		if cells.has(c) or _in_plaza(c):
			continue
		deco.set_cell(c, 0, DECO_FLOWER if _rng.randf() < 0.15 else DECO_TUFTS[_rng.randi_range(0, 3)])
	# 沙滩点缀：白色小簇当贝壳/浪花痕（避开码头木板）
	for i in 12:
		var c := Vector2i(_rng.randi_range(0, MAP_W - 1), _rng.randi_range(BEACH_Y + 1, WATER_Y - 1))
		if c.x >= DOCK_X and c.x < DOCK_X + 3:
			continue
		deco.set_cell(c, 0, Vector2i(_rng.randi_range(0, 3), 3))

func _in_plaza(c: Vector2i) -> bool:
	return Rect2i(10, 9, 8, 6).has_point(c)

# ---------------- 建筑 / 自然物 ----------------

## 把一个图集区域盖章成 Sprite2D，原点在"脚底"（y-sort 用）
func _stamp_at(r: Array, at: Vector2i) -> Sprite2D:
	var s := Sprite2D.new()
	s.texture = _tex(r[0])
	s.region_enabled = true
	s.region_rect = Rect2(r[1] * TILE, r[2] * TILE, r[3] * TILE, r[4] * TILE)
	s.centered = false
	s.offset = Vector2(0, -r[4] * TILE)
	s.position = Vector2(at.x * TILE, (at.y + r[4]) * TILE)
	_objects.add_child(s)
	return s

func _add_label(text: String, center_px: Vector2) -> void:
	var lbl := Label.new()
	lbl.text = text
	lbl.add_theme_font_size_override("font_size", 12)
	lbl.add_theme_color_override("font_color", Color("f5f0e8"))
	lbl.add_theme_color_override("font_outline_color", Color("1a1626"))
	lbl.add_theme_constant_override("outline_size", 4)
	_labels.add_child(lbl)
	lbl.reset_size()
	var pos := center_px - Vector2(lbl.size.x / 2.0, lbl.size.y)
	pos.x = clampf(pos.x, 2.0, MAP_W * TILE - lbl.size.x - 2.0)
	pos.y = maxf(pos.y, 2.0)
	lbl.position = pos

func _build_nature() -> void:
	# 森林（西北角树丛）
	_stamp_at(R_PINE_BIG, Vector2i(0, 0))
	_stamp_at(R_ROUND_BIG, Vector2i(4, 0))
	_stamp_at(R_GREEN_WIDE, Vector2i(2, 2))
	_stamp_at(R_PINE_S, Vector2i(0, 3))
	_stamp_at(R_TREE_S, Vector2i(5, 3))
	# 农田
	_stamp_at(R_HAY, Vector2i(9, 2))
	_stamp_at(R_HAY, Vector2i(12, 2))
	_stamp_at(R_BALE, Vector2i(8, 3))
	_stamp_at(R_CART, Vector2i(8, 0))
	# 花店门口的花与树篱
	for i in 4:
		_stamp_at(R_SUNFLOWER if i % 2 == 0 else R_FLOWER_R, Vector2i(21 + i, 5))
	# 广场西北的大樱花树（镇眼）
	_stamp_at(R_SAKURA, Vector2i(8, 6))
	# 白花树点缀图书馆旁
	_stamp_at(R_WHITE_BIG, Vector2i(19, 0))
	# 散树：镇里零星几棵
	_stamp_at(R_TREE_S, Vector2i(7, 10))
	_stamp_at(R_PINE_S, Vector2i(18, 14))
	_stamp_at(R_TREE_S, Vector2i(28, 2))
	_stamp_at(R_ROUND_BIG, Vector2i(6, 13))
	_stamp_at(R_TREE_S, Vector2i(25, 13))
	# 海滩礁石
	_stamp_at(R_ROCK, Vector2i(5, 19))
	_stamp_at(R_ROCK, Vector2i(31, 19))
	# 码头边小船
	_stamp_at(R_BOAT, Vector2i(28, 20))

func _build_plaza_props(lights_parent: Node2D) -> void:
	# 南入口鸟居（中轴路穿过）
	_stamp_at(R_TORII, Vector2i(12, 15))
	# 石柱灯一对 + 暖光
	for x in [11, 15]:
		_stamp_at(R_PILLAR, Vector2i(x, 9))
		_add_glow(Vector2((x + 0.5) * TILE, 9.6 * TILE), 44.0, Color("ffd27a"), lights_parent)
	# 广场周边灌木 + 摊车 + 石子
	_stamp_at(R_BUSH, Vector2i(10, 14))
	_stamp_at(R_BUSH2, Vector2i(17, 9))
	_stamp_at(R_BUSH, Vector2i(17, 14))
	_stamp_at(R_CART, Vector2i(16, 11))
	for c in [Vector2i(11, 13), Vector2i(15, 10), Vector2i(13, 12)]:
		_stamp_at(R_STONES, c)
	# 广场中央暖光（夜里像有篝火/灯串）
	_add_glow(Vector2(14.0 * TILE, 11.5 * TILE), 90.0, Color("ffcf8a"), lights_parent)

## 建筑门口的暖窗光（挂 lights_parent，白天由 Main 隐藏）
func _add_door_glow(r: Array, at: Vector2i, lights_parent: Node2D) -> void:
	var cx: float = (at.x + r[3] / 2.0) * TILE
	var cy: float = (at.y + r[4] - 0.4) * TILE
	_add_glow(Vector2(cx, cy), 34.0, Color("ffcf6b"), lights_parent)

func _add_glow(pos: Vector2, radius: float, col: Color, parent: Node2D) -> void:
	var grad := Gradient.new()
	grad.offsets = PackedFloat32Array([0.0, 1.0])
	grad.colors = PackedColorArray([Color(col.r, col.g, col.b, 0.36), Color(col.r, col.g, col.b, 0.0)])
	var gt := GradientTexture2D.new()
	gt.gradient = grad
	gt.fill = GradientTexture2D.FILL_RADIAL
	gt.fill_from = Vector2(0.5, 0.5)
	gt.fill_to = Vector2(1.0, 0.5)
	gt.width = int(radius * 2.0)
	gt.height = int(radius * 2.0)
	var s := Sprite2D.new()
	s.texture = gt
	s.position = pos
	var mat := CanvasItemMaterial.new()
	mat.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
	s.material = mat
	parent.add_child(s)

# ---------------- 角色定位 ----------------

func _fallback_stand() -> Vector2i:
	# 未知地点（换剧本时出现）：沿沙滩排开
	var s := Vector2i(2 + (_fallback_i % 9) * 4, 19)
	_fallback_i += 1
	return s

func zone_center(id: String) -> Vector2:
	return _zone_pos.get(id, Vector2(MAP_W * TILE / 2.0, MAP_H * TILE / 2.0))

func slot(id: String, index: int) -> Vector2:
	# 在地点内把角色排开（每行 3 个）
	var c := zone_center(id)
	var col := index % 3
	var row := int(index / 3.0)
	return c + Vector2((col - 1) * 34.0, row * 20.0)
