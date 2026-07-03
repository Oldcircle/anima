extends Node2D
## Ninja Adventure 像素小镇 · 世界 2.0（P3 完整游戏化）
##
## - 72x40 大地图：树墙边界 + 草地/沙滩/海/土路/池塘，不再有屏幕边裁一半的贴图
## - 13 个室内场景（咖啡馆/酒吧/图书馆/杂货店/面包坊/花店/7 栋住宅），摆在小镇下方的
##   独立"房间区"，相机跳转进入；建筑上方有居住者小人徽章，点建筑进室内
## - AStarGrid2D 网格寻路：建筑/树/水/家具是障碍，角色沿路网绕行
## - 对外 API：build / zone_center / slot / space_of / room_rect / path_cells /
##   update_badge / is_interior / demo_locations / name_for / type_for
##
## 素材：assets/ninja_adventure（CC0，见目录内 README.md）

signal building_clicked(loc_id: String)

const TILE := 16
const MAP_W := 72
const MAP_H := 40
const ROOM_ROW_Y := 44          # 室内区起始 tile 行（小镇下方，小镇相机看不到）

const TS_DIR := "res://assets/ninja_adventure/tilesets/"
const PROP_DIR := "res://assets/ninja_adventure/props/"
const CHAR_DIR := "res://assets/ninja_adventure/characters/"

# ---- TilesetField：草地基底 + 沙滩 blob ----
const GRASS_C := Vector2i(1, 4)
const SAND_T := Vector2i(1, 0)
const SAND_C := Vector2i(1, 1)

# ---- TilesetWater：海面 / 码头板 / 草地池塘 / 点缀 ----
# 注意：cols 4..8 的水块带"沉底沙丘圆圈"装饰，铺满会像满海半截石头 —— 海面只用纯水 (1,1)
const WATER_T := Vector2i(1, 0)          # 干净海岸线（白沫顶边）
const WATER_C := Vector2i(1, 1)          # 纯净海水
const WATER_SHEEN := Vector2i(11, 2)     # 波光（低频点缀）
const WATER_PEBBLE := Vector2i(11, 1)
const WATER_FISH := Vector2i(11, 4)
const WATER_LILY := Vector2i(11, 3)
const DOCK_COL_ROWS := [12, 13, 14, 15]      # 码头板（cols 0..2 x rows 12..15）
const POND := {"tl": Vector2i(0, 6), "t": Vector2i(1, 6), "tr": Vector2i(2, 6),
	"l": Vector2i(0, 7), "c": Vector2i(1, 7), "r": Vector2i(2, 7),
	"bl": Vector2i(0, 8), "b": Vector2i(1, 8), "br": Vector2i(2, 8)}

# ---- TilesetFloor：草地土路 blob（rows 7..13）----
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

# ---- TilesetFloorDetail：地面点缀 ----
const DECO_TUFTS := [Vector2i(0, 2), Vector2i(1, 2), Vector2i(2, 2), Vector2i(3, 2)]
const DECO_FLOWER := Vector2i(5, 2)

# ---- TilesetWallSimple：室内墙 9 宫格（4 色，base = 各变体左上角）----
const WALL_TAN := Vector2i(0, 0)
const WALL_ORANGE := Vector2i(5, 0)
const WALL_BROWN := Vector2i(0, 6)
const WALL_GREEN := Vector2i(5, 6)

# ---- TilesetInteriorFloor：室内地板 ----
const FLOOR_PLANK := Vector2i(2, 13)     # 浅色木地板
const FLOOR_DARK := Vector2i(13, 13)     # 深色木地板
const FLOOR_BRICK := Vector2i(1, 3)      # 米色砖纹
const FLOOR_ORANGE := Vector2i(1, 9)     # 橙色砖纹
const RUG_TAN := ["TilesetInteriorFloor", 11, 0, 4, 4]    # 4x4 地毯 blob
const RUG_GREEN := ["TilesetInteriorFloor", 11, 6, 4, 4]

# ---- 图集区域图章（tex, tile_x, tile_y, w, h）----
const R_HOME_A := ["TilesetHouse", 0, 0, 4, 3]
const R_HOME_B := ["TilesetHouse", 8, 0, 4, 3]
const R_HOUSE_BEIGE := ["TilesetHouse", 4, 0, 4, 3]
const R_INN := ["TilesetHouse", 26, 0, 3, 3]
const R_BAR := ["TilesetHouse", 12, 0, 4, 3]
const R_CAFE := ["TilesetHouse", 16, 0, 3, 3]
const R_SHOP := ["TilesetHouse", 19, 0, 4, 3]       # 杂货店实际 4 格宽（含菜摊）
const R_BAKERY := ["TilesetHouse", 23, 0, 3, 3]     # 圆顶点心铺在 23..25
const R_LIBRARY := ["TilesetHouse", 25, 10, 4, 4]
const R_TORII := ["TilesetHouse", 0, 5, 3, 2]
const R_PILLAR := ["TilesetHouse", 0, 15, 1, 3]     # 石柱含底座共 3 格高
const R_NOREN_A := ["TilesetHouse", 22, 20, 1, 2]
const R_NOREN_B := ["TilesetHouse", 23, 20, 1, 2]
const R_BASKET := ["TilesetHouse", 18, 13, 1, 1]    # 红果篮（完整 1x1）
const R_BREAD := ["TilesetHouse", 20, 14, 1, 1]     # 面包篮（完整 1x1）
const R_VEG := ["TilesetHouse", 19, 14, 1, 1]       # 菜篮（完整 1x1）
const R_BARREL := ["TilesetHouse", 16, 15, 1, 1]

const R_PINE_BIG := ["TilesetNature", 0, 2, 4, 3]
const R_ROUND_BIG := ["TilesetNature", 4, 2, 2, 3]
const R_WHITE_BIG := ["TilesetNature", 8, 2, 4, 3]
const R_SAKURA := ["TilesetNature", 12, 2, 4, 3]
const R_GREEN_WIDE := ["TilesetNature", 16, 2, 4, 3]
const R_TREE_S := ["TilesetNature", 0, 0, 2, 2]
const R_PINE_S := ["TilesetNature", 2, 0, 2, 2]
const R_ROCK := ["TilesetNature", 13, 8, 2, 2]      # 完整单块圆岩
const R_ROCK_S := ["TilesetNature", 15, 9, 1, 1]
const R_BUSH := ["TilesetNature", 1, 10, 1, 1]      # 完整圆灌木（0/2 列是无躯干的叶簇，别用）
const R_BUSH2 := ["TilesetNature", 8, 11, 1, 1]     # 完整蓬松灌木
const R_SUNFLOWER := ["TilesetNature", 0, 11, 1, 1]
const R_FLOWER_R := ["TilesetNature", 3, 11, 1, 1]

const R_HAY := ["TilesetElement", 13, 4, 3, 3]
const R_BALE := ["TilesetElement", 12, 4, 1, 2]
const R_CART := ["TilesetElement", 0, 3, 2, 2]
const R_BOAT_S := ["TilesetWater", 26, 0, 2, 2]
const R_STONES := ["TilesetFloorDetail", 9, 0, 1, 1]

# 室内家具（TilesetElement / TilesetBed）
const F_PLANT := ["TilesetElement", 0, 7, 1, 2]
const F_CABINET := ["TilesetElement", 1, 7, 1, 2]
const F_DRAWER := ["TilesetElement", 2, 7, 1, 2]
const F_BOOKSHELF := ["TilesetElement", 3, 7, 1, 2]
const F_SHELF := ["TilesetElement", 4, 7, 1, 2]
const F_BIGSHELF := ["TilesetElement", 6, 7, 2, 2]
const F_TABLE := ["TilesetElement", 5, 7, 1, 2]
const F_COUNTER := ["TilesetElement", 11, 1, 3, 1]
const F_STOOL := ["TilesetElement", 2, 0, 1, 1]
const F_JAR := ["TilesetElement", 1, 0, 1, 1]
const F_LAMP := ["TilesetElement", 12, 0, 1, 1]
const F_LADDER := ["TilesetBed", 7, 6, 2, 3]
const F_RUG3 := ["TilesetBed", 2, 9, 3, 3]
const BEDS := {
	"tan": ["TilesetBed", 0, 0, 2, 3], "red": ["TilesetBed", 0, 3, 2, 3],
	"blue": ["TilesetBed", 7, 3, 2, 3], "green": ["TilesetBed", 7, 0, 2, 3],
	"white": ["TilesetBed", 0, 6, 2, 3],
}

# ---- 户外布局（tile 坐标；bldg/at = 建筑图章，stand = 角色聚集点）----
const LAYOUT := {
	"forest":            {"stand": Vector2i(7, 7)},
	"farm":              {"stand": Vector2i(19, 9)},
	"library":           {"bldg": R_LIBRARY, "at": Vector2i(30, 2), "stand": Vector2i(32, 7)},
	"flower_shop":       {"bldg": R_HOUSE_BEIGE, "at": Vector2i(37, 3), "stand": Vector2i(39, 7)},
	"shop":              {"bldg": R_SHOP, "at": Vector2i(8, 12), "stand": Vector2i(10, 16)},
	"bakery":            {"bldg": R_BAKERY, "at": Vector2i(14, 12), "stand": Vector2i(15, 16)},
	"cafe":              {"bldg": R_CAFE, "at": Vector2i(20, 12), "stand": Vector2i(21, 16)},
	"plaza":             {"stand": Vector2i(34, 16)},
	"bar":               {"bldg": R_BAR, "at": Vector2i(45, 14), "stand": Vector2i(46, 17)},
	"beach":             {"stand": Vector2i(30, 28)},
	"dock":              {"stand": Vector2i(51, 31)},
	"home_asuka":        {"bldg": R_HOME_A, "at": Vector2i(44, 2), "stand": Vector2i(46, 6)},
	"home_l":            {"bldg": R_INN, "at": Vector2i(50, 2), "stand": Vector2i(51, 6)},
	"home_lelouch":      {"bldg": R_HOME_B, "at": Vector2i(56, 2), "stand": Vector2i(58, 6)},
	"home_light":        {"bldg": R_HOUSE_BEIGE, "at": Vector2i(62, 2), "stand": Vector2i(64, 6)},
	"home_rei":          {"bldg": R_HOME_A, "at": Vector2i(47, 8), "stand": Vector2i(49, 12)},
	"home_senjougahara": {"bldg": R_HOME_B, "at": Vector2i(53, 8), "stand": Vector2i(55, 12)},
	"home_shinji":       {"bldg": R_HOUSE_BEIGE, "at": Vector2i(59, 8), "stand": Vector2i(61, 12)},
}

# ---- 室内房间（尺寸含墙；wall = 9 宫格变体基点，floor = 地板 tile）----
const ROOMS := {
	"cafe":         {"size": Vector2i(14, 9), "wall": WALL_ORANGE, "floor": FLOOR_BRICK},
	"bar":          {"size": Vector2i(13, 9), "wall": WALL_BROWN, "floor": FLOOR_DARK},
	"library":      {"size": Vector2i(16, 11), "wall": WALL_GREEN, "floor": FLOOR_PLANK, "rug": RUG_GREEN},
	"shop":         {"size": Vector2i(12, 9), "wall": WALL_TAN, "floor": FLOOR_PLANK},
	"bakery":       {"size": Vector2i(12, 9), "wall": WALL_ORANGE, "floor": FLOOR_ORANGE},
	"flower_shop":  {"size": Vector2i(12, 9), "wall": WALL_TAN, "floor": FLOOR_PLANK},
	"home_asuka":        {"size": Vector2i(10, 8), "wall": WALL_TAN, "floor": FLOOR_PLANK, "bed": "red", "extra": F_DRAWER},
	"home_l":            {"size": Vector2i(10, 8), "wall": WALL_BROWN, "floor": FLOOR_DARK, "bed": "white", "extra": F_LADDER},
	"home_lelouch":      {"size": Vector2i(10, 8), "wall": WALL_BROWN, "floor": FLOOR_DARK, "bed": "tan", "extra": F_BOOKSHELF},
	"home_light":        {"size": Vector2i(10, 8), "wall": WALL_TAN, "floor": FLOOR_PLANK, "bed": "blue", "extra": F_BOOKSHELF},
	"home_rei":          {"size": Vector2i(10, 8), "wall": WALL_TAN, "floor": FLOOR_PLANK, "bed": "white", "extra": F_PLANT},
	"home_senjougahara": {"size": Vector2i(10, 8), "wall": WALL_GREEN, "floor": FLOOR_PLANK, "bed": "green", "extra": F_CABINET},
	"home_shinji":       {"size": Vector2i(10, 8), "wall": WALL_TAN, "floor": FLOOR_PLANK, "bed": "tan", "extra": F_DRAWER},
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

const PLAZA := Rect2i(27, 12, 15, 10)
const BEACH_Y := 25        # 沙滩过渡行
const WATER_Y := 31        # 海面起始行
const PIER_X := 50         # 栈桥左缘（3 宽）
const PIER_Y0 := 27        # 栈桥起始行（沙滩上）

var grid: AStarGrid2D      # 小镇寻路网格（Main 经 path_points 使用）
var _zone_pos := {}        # id -> 站点像素坐标
var _room_origin := {}     # id -> 房间左上角 tile（含墙）
var _textures := {}
var _objects: Node2D
var _labels: Node2D
var _rooms_root: Node2D    # 室内区根（Main 传入，不吃夜色染色 —— 屋里始终亮着）
var _stamp_root: Node2D    # 图章当前挂载点（户外 = _objects，建房间时切到室内）
var _badges := {}          # id -> 徽章 Node2D（内含小人图标行）
var _fallback_i := 0
var _rng := RandomNumberGenerator.new()

# ============================ 对外 API ============================

func type_for(id: String, fallback: String = "public") -> String:
	if id.begins_with("home_"):
		return "residential"
	return TYPE_BY_ID.get(id, fallback)

func name_for(id: String) -> String:
	return NAME_BY_ID.get(id, id)

func is_interior(id: String) -> bool:
	return ROOMS.has(id)

## 角色所在的"空间"：小镇 = "town"，室内 = 地点 id
func space_of(id: String) -> String:
	return id if ROOMS.has(id) else "town"

func zone_center(id: String) -> Vector2:
	return _zone_pos.get(id, Vector2(MAP_W * TILE / 2.0, 20 * TILE))

func slot(id: String, index: int) -> Vector2:
	var c := zone_center(id)
	var col := index % 3
	var row := int(index / 3.0)
	return c + Vector2((col - 1) * 34.0, row * 20.0)

## 房间的像素范围（相机取景用）
func room_rect(id: String) -> Rect2:
	if not _room_origin.has(id):
		return Rect2(0, 0, MAP_W * TILE, MAP_H * TILE)
	var o: Vector2i = _room_origin[id]
	var sz: Vector2i = ROOMS[id]["size"]
	return Rect2(o.x * TILE, o.y * TILE, sz.x * TILE, sz.y * TILE)

## 小镇寻路：像素 → 途径点数组（含终点）。找不到路时退化为直线
func path_points(from_px: Vector2, to_px: Vector2) -> PackedVector2Array:
	var out := PackedVector2Array()
	var a := _walkable_cell(Vector2i(from_px / TILE))
	var b := _walkable_cell(Vector2i(to_px / TILE))
	if a != b:
		var cells := grid.get_id_path(a, b)
		for i in range(1, cells.size()):
			out.append(Vector2(cells[i]) * TILE + Vector2(TILE / 2.0, TILE / 2.0))
	out.append(to_px)
	return out

func _walkable_cell(c: Vector2i) -> Vector2i:
	c = c.clamp(Vector2i.ZERO, Vector2i(MAP_W - 1, MAP_H - 1))
	if not grid.is_point_solid(c):
		return c
	for r in range(1, 4):   # 从障碍格向外找最近可走格
		for dy in range(-r, r + 1):
			for dx in range(-r, r + 1):
				var n := (c + Vector2i(dx, dy)).clamp(Vector2i.ZERO, Vector2i(MAP_W - 1, MAP_H - 1))
				if not grid.is_point_solid(n):
					return n
	return c

## 更新建筑上方的居住者徽章（skins = 里面角色的皮肤名列表）
func update_badge(id: String, skins: Array) -> void:
	if not _badges.has(id):
		return
	var badge: Node2D = _badges[id]
	for child in badge.get_children():
		child.queue_free()
	badge.visible = not skins.is_empty()
	if skins.is_empty():
		return
	var n := mini(skins.size(), 4)
	var bg := ColorRect.new()
	bg.color = Color(0.07, 0.08, 0.18, 0.8)
	bg.size = Vector2(n * 14 + 6, 18)
	bg.position = Vector2(-bg.size.x / 2.0, -9)
	badge.add_child(bg)
	for i in n:
		var s := Sprite2D.new()
		var at := AtlasTexture.new()
		at.atlas = load(CHAR_DIR + str(skins[i]) + "/Idle.png")
		at.region = Rect2(0, 0, 16, 16)
		s.texture = at
		s.position = Vector2(-bg.size.x / 2.0 + 10 + i * 14, 0)
		badge.add_child(s)
	if skins.size() > n:
		var more := Label.new()
		more.text = "+%d" % (skins.size() - n)
		more.add_theme_font_size_override("font_size", 12)
		more.position = Vector2(bg.size.x / 2.0 + 1, -10)
		badge.add_child(more)

func demo_locations() -> Array:
	var out := []
	for id in LAYOUT:
		out.append({"id": id, "name": name_for(id), "type": type_for(id)})
	return out

# ============================ 构建 ============================

func build(locations: Array, lights_parent: Node2D, rooms_parent: Node2D) -> void:
	_rng.seed = 20260703
	_rooms_root = rooms_parent
	_init_grid()
	_build_ground()
	_build_paths()
	_objects = Node2D.new()
	_objects.name = "Objects"
	_objects.y_sort_enabled = true
	add_child(_objects)
	_stamp_root = _objects
	_labels = Node2D.new()
	_labels.name = "Labels"
	_labels.z_index = 10
	add_child(_labels)
	_build_nature(lights_parent)
	for loc in locations:
		var id: String = str(loc.get("id", ""))
		if id == "":
			continue
		var conf: Dictionary = LAYOUT.get(id, {})
		var stand: Vector2i = conf["stand"] if conf.has("stand") else _fallback_stand()
		var display := name_for(id) if NAME_BY_ID.has(id) else str(loc.get("name", id))
		if conf.has("bldg"):
			var at: Vector2i = conf["at"]
			var r: Array = conf["bldg"]
			_stamp_at(r, at)
			_mark_solid(Rect2i(at.x, at.y, r[3], r[4]))
			_add_door_glow(r, at, lights_parent)
			_add_label(display, Vector2((at.x + r[3] / 2.0) * TILE, at.y * TILE - 4))
			if ROOMS.has(id):
				_add_building_area(id, at, r)
				_add_badge(id, at, r)
		else:
			_add_label(display, Vector2((stand.x + 0.5) * TILE, (stand.y - 1.6) * TILE))
		_zone_pos[id] = Vector2((stand.x + 0.5) * TILE, (stand.y + 0.5) * TILE)
	_decorate_shops()
	_build_plaza_props(lights_parent)
	_build_rooms(locations)
	grid.update()
	_apply_solids()
	print("[Town] 世界 2.0：%d 地点 / %d 室内 / %dx%d 地图" % [_zone_pos.size(), _room_origin.size(), MAP_W, MAP_H])

# ---------------- 寻路网格 ----------------

var _solid_rects: Array[Rect2i] = []

func _init_grid() -> void:
	grid = AStarGrid2D.new()
	grid.region = Rect2i(0, 0, MAP_W, MAP_H)
	grid.cell_size = Vector2(TILE, TILE)
	grid.diagonal_mode = AStarGrid2D.DIAGONAL_MODE_ONLY_IF_NO_OBSTACLES
	_solid_rects.clear()

func _mark_solid(r: Rect2i) -> void:
	_solid_rects.append(r)

func _apply_solids() -> void:
	# 海面（栈桥除外）
	grid.fill_solid_region(Rect2i(0, WATER_Y, MAP_W, MAP_H - WATER_Y), true)
	grid.fill_solid_region(Rect2i(PIER_X, WATER_Y, 3, PIER_Y0 + 11 - WATER_Y), false)
	for r in _solid_rects:
		grid.fill_solid_region(r.intersection(Rect2i(0, 0, MAP_W, MAP_H)), true)

# ---------------- 地形 ----------------

func _tex(name: String) -> Texture2D:
	if not _textures.has(name):
		_textures[name] = load(TS_DIR + name + ".png")
	return _textures[name]

func _layer(tex_name: String, parent: Node = null) -> TileMapLayer:
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
	(parent if parent else self).add_child(layer)
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
		water.set_cell(Vector2i(x, WATER_Y), 0, WATER_T)
		for y in range(WATER_Y + 1, MAP_H):
			# 纯水为主，撒少量波光
			var t := WATER_C if _rng.randf() > 0.07 else WATER_SHEEN
			water.set_cell(Vector2i(x, y), 0, t)
	for spot in [[5, 33, WATER_FISH], [14, 35, WATER_LILY], [26, 34, WATER_FISH],
			[38, 36, WATER_LILY], [60, 33, WATER_FISH], [66, 36, WATER_LILY],
			[44, 37, WATER_FISH], [30, 38, WATER_PEBBLE]]:
		water.set_cell(Vector2i(spot[0], spot[1]), 0, spot[2])

	# 草地池塘（森林南侧）
	var pond := _layer("TilesetWater")
	pond.name = "Pond"
	var pr := Rect2i(2, 12, 5, 5)
	for y in range(pr.position.y, pr.end.y):
		for x in range(pr.position.x, pr.end.x):
			var t: Vector2i = POND["c"]
			var left := x == pr.position.x
			var right := x == pr.end.x - 1
			var top := y == pr.position.y
			var bottom := y == pr.end.y - 1
			if top and left: t = POND["tl"]
			elif top and right: t = POND["tr"]
			elif bottom and left: t = POND["bl"]
			elif bottom and right: t = POND["br"]
			elif top: t = POND["t"]
			elif bottom: t = POND["b"]
			elif left: t = POND["l"]
			elif right: t = POND["r"]
			pond.set_cell(Vector2i(x, y), 0, t)
	pond.set_cell(Vector2i(4, 14), 0, WATER_LILY)
	_mark_solid(pr)

	# 栈桥：3 宽木板从沙滩伸进海里（可行走）
	var pier := _layer("TilesetWater")
	pier.name = "Pier"
	for i in 11:
		var row: int = DOCK_COL_ROWS[mini(int(i / 3.0), 2)] if i < 10 else DOCK_COL_ROWS[3]
		for dx in 3:
			pier.set_cell(Vector2i(PIER_X + dx, PIER_Y0 + i), 0, Vector2i(dx, row))

func _build_paths() -> void:
	var path := _layer("TilesetFloor")
	path.name = "Paths"
	var cells := {}

	var mark := func(c: Vector2i, kind: String) -> void:
		if cells.has(c) and cells[c] != kind:
			cells[c] = "x"
		else:
			cells[c] = kind

	var seg_h := func(x0: int, x1: int, y: int) -> void:
		for x in range(x0, x1 + 1):
			mark.call(Vector2i(x, y), "h")
	var seg_v := func(x: int, y0: int, y1: int) -> void:
		for y in range(y0, y1 + 1):
			mark.call(Vector2i(x, y), "v")

	seg_h.call(3, 68, 18)          # 主街
	seg_v.call(34, 6, 25)          # 中轴：图书馆西侧 → 广场 → 鸟居 → 海滩
	seg_v.call(32, 6, 11)          # 图书馆门前
	seg_v.call(39, 7, 11)          # 花店门前
	seg_v.call(10, 15, 17)         # 杂货店
	seg_v.call(15, 15, 17)         # 面包坊
	seg_v.call(21, 15, 17)         # 咖啡馆
	seg_v.call(19, 9, 17)          # 农田 → 主街
	seg_v.call(7, 8, 17)           # 森林 → 主街（贴池塘东侧）
	seg_h.call(44, 68, 6)          # 住宅一排门前
	seg_h.call(47, 64, 12)         # 住宅二排门前
	seg_v.call(44, 6, 18)          # 住宅区西纵路
	seg_v.call(56, 12, 18)         # 住宅区中纵路
	seg_v.call(68, 6, 18)          # 住宅区东纵路
	seg_v.call(51, 19, 26)         # 主街 → 码头
	seg_h.call(46, 47, 17)         # 酒吧门口接主街

	# 广场大块
	for y in range(PLAZA.position.y, PLAZA.end.y):
		for x in range(PLAZA.position.x, PLAZA.end.x):
			var t := P_C
			var left := x == PLAZA.position.x
			var right := x == PLAZA.end.x - 1
			var top := y == PLAZA.position.y
			var bottom := y == PLAZA.end.y - 1
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
		if c.y > BEACH_Y:
			continue
		var kind: String = cells[c]
		var t := P_C
		if kind == "h":
			t = PH_M
			if not cells.has(c + Vector2i.LEFT) and not PLAZA.has_point(c + Vector2i.LEFT): t = PH_L
			elif not cells.has(c + Vector2i.RIGHT) and not PLAZA.has_point(c + Vector2i.RIGHT): t = PH_R
		elif kind == "v":
			t = PV_M
			if not cells.has(c + Vector2i.UP) and not PLAZA.has_point(c + Vector2i.UP): t = PV_T
			elif not cells.has(c + Vector2i.DOWN) and not PLAZA.has_point(c + Vector2i.DOWN): t = PV_B
		path.set_cell(c, 0, t)

	var deco := _layer("TilesetFloorDetail")
	deco.name = "Deco"
	for i in 200:
		var c := Vector2i(_rng.randi_range(2, MAP_W - 3), _rng.randi_range(2, BEACH_Y - 1))
		if cells.has(c) or PLAZA.has_point(c):
			continue
		deco.set_cell(c, 0, DECO_FLOWER if _rng.randf() < 0.15 else DECO_TUFTS[_rng.randi_range(0, 3)])
	for i in 26:
		var c := Vector2i(_rng.randi_range(1, MAP_W - 2), _rng.randi_range(BEACH_Y + 1, WATER_Y - 1))
		if c.x >= PIER_X - 1 and c.x < PIER_X + 4:
			continue
		deco.set_cell(c, 0, Vector2i(_rng.randi_range(0, 3), 3))

# ---------------- 图章 / 标签 ----------------

func _stamp_at(r: Array, at: Vector2i) -> Sprite2D:
	return _stamp_px(r, Vector2(at.x, at.y) * TILE)

func _stamp_px(r: Array, pos_px: Vector2) -> Sprite2D:
	var s := Sprite2D.new()
	s.texture = _tex(r[0])
	s.region_enabled = true
	s.region_rect = Rect2(r[1] * TILE, r[2] * TILE, r[3] * TILE, r[4] * TILE)
	s.centered = false
	s.offset = Vector2(0, -r[4] * TILE)
	s.position = pos_px + Vector2(0, r[4] * TILE)
	_stamp_root.add_child(s)
	return s

## 图章 + 标记障碍（树木/道具用）
func _stamp_block(r: Array, at: Vector2i) -> void:
	_stamp_at(r, at)
	_mark_solid(Rect2i(at.x, at.y, r[3], r[4]))

func _sprite_px(path: String, pos_px: Vector2) -> Sprite2D:
	var s := Sprite2D.new()
	s.texture = load(path)
	s.centered = false
	s.position = pos_px
	_stamp_root.add_child(s)
	return s

func _add_label(text: String, center_px: Vector2, parent: Node = null) -> void:
	var lbl := Label.new()
	lbl.text = text
	lbl.add_theme_font_size_override("font_size", 12)
	lbl.add_theme_color_override("font_color", Color("f5f0e8"))
	lbl.add_theme_color_override("font_outline_color", Color("1a1626"))
	lbl.add_theme_constant_override("outline_size", 4)
	(parent if parent else _labels).add_child(lbl)
	lbl.reset_size()
	var pos := center_px - Vector2(lbl.size.x / 2.0, lbl.size.y)
	if parent == null:
		pos.x = clampf(pos.x, 2.0, MAP_W * TILE - lbl.size.x - 2.0)
		pos.y = maxf(pos.y, 2.0)
	lbl.position = pos

func _add_building_area(id: String, at: Vector2i, r: Array) -> void:
	var area := Area2D.new()
	var cs := CollisionShape2D.new()
	var shape := RectangleShape2D.new()
	shape.size = Vector2(r[3] * TILE, r[4] * TILE)
	cs.shape = shape
	cs.position = Vector2((at.x + r[3] / 2.0) * TILE, (at.y + r[4] / 2.0) * TILE)
	area.add_child(cs)
	area.input_event.connect(func(_vp: Node, ev: InputEvent, _i: int) -> void:
		if ev is InputEventMouseButton and ev.pressed and ev.button_index == MOUSE_BUTTON_LEFT:
			building_clicked.emit(id)
	)
	add_child(area)

func _add_badge(id: String, at: Vector2i, r: Array) -> void:
	# 居住者徽章：悬在建筑右上角，缩小一档避免误看成建筑的一部分
	var badge := Node2D.new()
	badge.position = Vector2((at.x + r[3]) * TILE - 6, at.y * TILE - 8)
	badge.scale = Vector2(0.8, 0.8)
	badge.z_index = 11
	badge.visible = false
	add_child(badge)
	_badges[id] = badge

# ---------------- 户外场景 ----------------

func _build_nature(lights_parent: Node2D) -> void:
	# 地图边界树墙（北一整排 + 东西两列到沙滩）
	for x in range(0, MAP_W - 1, 2):
		_stamp_block(R_TREE_S if (x / 2) % 3 != 0 else R_PINE_S, Vector2i(x, 0))
	for y in range(2, BEACH_Y - 2, 2):
		_stamp_block(R_PINE_S if (y / 2) % 2 == 0 else R_TREE_S, Vector2i(0, y))
		_stamp_block(R_TREE_S if (y / 2) % 2 == 0 else R_PINE_S, Vector2i(MAP_W - 2, y))

	# 森林（西北，中间留空地当聚集点，藏一座小神社）
	_stamp_block(R_PINE_BIG, Vector2i(2, 2))
	_stamp_block(R_GREEN_WIDE, Vector2i(7, 2))
	_stamp_block(R_ROUND_BIG, Vector2i(11, 3))
	_stamp_block(R_PINE_BIG, Vector2i(3, 6))
	_stamp_block(R_TREE_S, Vector2i(11, 7))
	_stamp_block(R_PINE_S, Vector2i(12, 5))
	_stamp_block(R_TORII, Vector2i(6, 4))          # 森林小神社入口
	_add_glow(Vector2(7.5 * TILE, 5.5 * TILE), 30.0, Color("ffd27a"), lights_parent)

	# 农田：围栏圈 + 两块干草田 + 草垛/推车/向日葵
	_build_fence(Rect2i(16, 3, 7, 6))
	_stamp_at(R_HAY, Vector2i(17, 4))
	_stamp_at(R_BALE, Vector2i(21, 4))
	_mark_solid(Rect2i(17, 4, 4, 3))
	_stamp_block(R_HAY, Vector2i(24, 4))
	_stamp_block(R_CART, Vector2i(24, 2))
	for i in 3:
		_stamp_at(R_SUNFLOWER, Vector2i(24 + i, 7))

	# 图书馆旁白花树、花店门前花圃
	_stamp_block(R_WHITE_BIG, Vector2i(26, 3))
	_stamp_block(R_WHITE_BIG, Vector2i(34, 2))
	for i in 4:
		_stamp_at(R_SUNFLOWER if i % 2 == 0 else R_FLOWER_R, Vector2i(37 + i, 6))
	_stamp_block(R_BUSH, Vector2i(36, 6))
	_stamp_block(R_BUSH2, Vector2i(41, 6))

	# 住宅区绿化
	_stamp_block(R_SAKURA, Vector2i(66, 2))
	_stamp_block(R_TREE_S, Vector2i(48, 5))
	_stamp_block(R_TREE_S, Vector2i(54, 11))
	_stamp_block(R_ROUND_BIG, Vector2i(65, 9))
	_stamp_block(R_BUSH, Vector2i(43, 12))
	_stamp_block(R_BUSH2, Vector2i(63, 12))

	# 镇中零散树木 / 灌木
	_stamp_block(R_ROUND_BIG, Vector2i(12, 9))
	_stamp_block(R_TREE_S, Vector2i(24, 9))
	_stamp_block(R_PINE_S, Vector2i(4, 20))
	_stamp_block(R_TREE_S, Vector2i(13, 21))
	_stamp_block(R_ROUND_BIG, Vector2i(23, 20))
	_stamp_block(R_TREE_S, Vector2i(43, 21))
	_stamp_block(R_GREEN_WIDE, Vector2i(58, 19))
	_stamp_block(R_BUSH, Vector2i(26, 17))
	_stamp_block(R_BUSH2, Vector2i(10, 20))

	# 海滩与码头：礁石 / 渔网 / 吊机 / 小船 / 大帆船
	_stamp_block(R_ROCK, Vector2i(7, 27))
	_stamp_block(R_ROCK, Vector2i(20, 29))
	_stamp_block(R_ROCK, Vector2i(40, 28))
	_stamp_block(R_ROCK, Vector2i(64, 27))
	_sprite_px(PROP_DIR + "FishNetFull.png", Vector2(45 * TILE, 27.5 * TILE))
	_mark_solid(Rect2i(45, 27, 2, 2))
	_stamp_at(R_ROCK_S, Vector2i(47, 29))
	_sprite_px(PROP_DIR + "Crane.png", Vector2(54 * TILE, 26.8 * TILE))
	_mark_solid(Rect2i(54, 27, 2, 2))
	_stamp_block(R_BOAT_S, Vector2i(46, 32))
	var boat := _sprite_px(PROP_DIR + "Boat.png", Vector2(55 * TILE, 32 * TILE))
	boat.z_index = 1
	_add_glow(Vector2((PIER_X + 1.5) * TILE, (WATER_Y + 2.0) * TILE), 64.0, Color("9fd0ff"), lights_parent)

func _build_fence(r: Rect2i) -> void:
	# TilesetHouse 的 9 宫格栅栏；底边中间留门
	var fence := _layer("TilesetHouse")
	fence.name = "Fence"
	var gate_x := r.position.x + r.size.x / 2
	for x in range(r.position.x, r.end.x):
		fence.set_cell(Vector2i(x, r.position.y), 0, Vector2i(10, 10))
		if x != gate_x:
			fence.set_cell(Vector2i(x, r.end.y - 1), 0, Vector2i(10, 12))
			_mark_solid(Rect2i(x, r.end.y - 1, 1, 1))
		_mark_solid(Rect2i(x, r.position.y, 1, 1))
	for y in range(r.position.y + 1, r.end.y - 1):
		fence.set_cell(Vector2i(r.position.x, y), 0, Vector2i(9, 11))
		fence.set_cell(Vector2i(r.end.x - 1, y), 0, Vector2i(13, 11))
		_mark_solid(Rect2i(r.position.x, y, 1, 1))
		_mark_solid(Rect2i(r.end.x - 1, y, 1, 1))
	fence.set_cell(r.position, 0, Vector2i(9, 10))
	fence.set_cell(Vector2i(r.end.x - 1, r.position.y), 0, Vector2i(13, 10))
	fence.set_cell(Vector2i(r.position.x, r.end.y - 1), 0, Vector2i(9, 12))
	fence.set_cell(Vector2i(r.end.x - 1, r.end.y - 1), 0, Vector2i(13, 12))

func _decorate_shops() -> void:
	# noren 布帘挂在门脸两侧（盖在建筑立面上），货物摆在门前地上
	_stamp_at(R_NOREN_A, Vector2i(20, 13))    # 咖啡馆（bldg 20,12 3x3）
	_stamp_at(R_NOREN_B, Vector2i(22, 13))
	_stamp_at(R_NOREN_B, Vector2i(45, 15))    # 酒吧（bldg 45,14 4x3）
	_stamp_at(R_NOREN_A, Vector2i(48, 15))
	_stamp_block(R_BARREL, Vector2i(49, 16))
	_stamp_block(R_BREAD, Vector2i(13, 15))   # 面包坊门前摆篮（bldg 14,12 3x3）
	_stamp_block(R_BASKET, Vector2i(17, 15))
	_stamp_block(R_BARREL, Vector2i(12, 13))  # 杂货店旁木桶（bldg 8,12 4x3）

func _build_plaza_props(lights_parent: Node2D) -> void:
	_stamp_block(R_TORII, Vector2i(33, 22))
	_stamp_block(R_SAKURA, Vector2i(25, 10))
	for x in [29, 39]:
		_stamp_block(R_PILLAR, Vector2i(x, 13))
		_add_glow(Vector2((x + 0.5) * TILE, 13.6 * TILE), 44.0, Color("ffd27a"), lights_parent)
	# 集市摊位（东侧）：长桌 + 货物摆在桌面上
	_stamp_at(F_COUNTER, Vector2i(37, 15))
	_stamp_at(R_BREAD, Vector2i(37, 15))
	_stamp_at(R_VEG, Vector2i(38, 15))
	_stamp_at(R_BASKET, Vector2i(39, 15))
	_mark_solid(Rect2i(37, 15, 3, 1))
	_stamp_at(F_COUNTER, Vector2i(37, 18))
	_stamp_at(R_BASKET, Vector2i(37, 18))
	_stamp_at(F_JAR, Vector2i(38, 18))
	_stamp_at(R_VEG, Vector2i(39, 18))
	_mark_solid(Rect2i(37, 18, 3, 1))
	_stamp_block(R_CART, Vector2i(30, 20))
	# 灌木 + 石子点缀
	for c in [Vector2i(27, 12), Vector2i(41, 12), Vector2i(27, 21), Vector2i(41, 21)]:
		_stamp_block(R_BUSH if (c.x + c.y) % 2 == 0 else R_BUSH2, c)
	_stamp_at(R_STONES, Vector2i(31, 18))
	_add_glow(Vector2(34.0 * TILE, 16.5 * TILE), 100.0, Color("ffcf8a"), lights_parent)

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

# ---------------- 室内 ----------------

func _build_rooms(locations: Array) -> void:
	var floorl := _layer("TilesetInteriorFloor", _rooms_root)
	floorl.name = "RoomFloors"
	var wall := _layer("TilesetWallSimple", _rooms_root)
	wall.name = "RoomWalls"
	var room_objects := Node2D.new()
	room_objects.name = "RoomObjects"
	room_objects.y_sort_enabled = true
	_rooms_root.add_child(room_objects)
	_stamp_root = room_objects
	var cursor := Vector2i(1, ROOM_ROW_Y)
	var ids: Array = locations.map(func(l): return str(l.get("id", "")))
	for id in ROOMS:
		if not ids.has(id):
			continue
		var spec: Dictionary = ROOMS[id]
		var sz: Vector2i = spec["size"]
		_room_origin[id] = cursor
		_room_frame(wall, floorl, cursor, sz, spec)
		_furnish(id, cursor, sz, spec)
		_add_label(name_for(id), Vector2((cursor.x + sz.x / 2.0) * TILE, cursor.y * TILE - 2), _rooms_root)
		cursor.x += sz.x + 14   # 间距拉开，相机进房间时看不到邻室
	_stamp_root = _objects
	# 室内站点：房间中下部一排
	for id in _room_origin:
		var o: Vector2i = _room_origin[id]
		var sz: Vector2i = ROOMS[id]["size"]
		_zone_pos[id] = Vector2((o.x + sz.x / 2.0) * TILE, (o.y + sz.y - 2.5) * TILE)

func _room_frame(wall: TileMapLayer, floorl: TileMapLayer, o: Vector2i, sz: Vector2i, spec: Dictionary) -> void:
	var wb: Vector2i = spec["wall"]
	var ft: Vector2i = spec["floor"]
	for y in range(1, sz.y - 1):
		for x in range(1, sz.x - 1):
			floorl.set_cell(o + Vector2i(x, y), 0, ft)
	if spec.has("rug"):
		var rug: Array = spec["rug"]
		var rp := o + Vector2i(int(sz.x / 2.0) - 2, int(sz.y / 2.0) - 2)
		for y in 4:
			for x in 4:
				floorl.set_cell(rp + Vector2i(x, y), 0, Vector2i(rug[1] + x, rug[2] + y))
	for x in range(1, sz.x - 1):
		wall.set_cell(o + Vector2i(x, 0), 0, wb + Vector2i(1, 0))
		wall.set_cell(o + Vector2i(x, sz.y - 1), 0, wb + Vector2i(1, 4))
	for y in range(1, sz.y - 1):
		wall.set_cell(o + Vector2i(0, y), 0, wb + Vector2i(0, 1))
		wall.set_cell(o + Vector2i(sz.x - 1, y), 0, wb + Vector2i(4, 1))
	wall.set_cell(o, 0, wb)
	wall.set_cell(o + Vector2i(sz.x - 1, 0), 0, wb + Vector2i(4, 0))
	wall.set_cell(o + Vector2i(0, sz.y - 1), 0, wb + Vector2i(0, 4))
	wall.set_cell(o + Vector2i(sz.x - 1, sz.y - 1), 0, wb + Vector2i(4, 4))

func _furnish(id: String, o: Vector2i, sz: Vector2i, spec: Dictionary) -> void:
	match id:
		"cafe":
			_stamp_at(F_COUNTER, o + Vector2i(2, 3))
			_stamp_at(F_COUNTER, o + Vector2i(5, 3))
			_stamp_at(R_BREAD, o + Vector2i(2, 2))
			_stamp_at(F_JAR, o + Vector2i(4, 2))
			_stamp_at(R_BASKET, o + Vector2i(6, 2))
			for i in 3:
				_stamp_at(F_STOOL, o + Vector2i(3 + i * 2, 5))
			_stamp_at(F_TABLE, o + Vector2i(10, 3))
			_stamp_at(F_TABLE, o + Vector2i(12, 3))
			_stamp_at(F_PLANT, o + Vector2i(1, 2))
			_stamp_at(F_LAMP, o + Vector2i(12, 6))
		"bar":
			_stamp_at(F_COUNTER, o + Vector2i(2, 3))
			_stamp_at(F_COUNTER, o + Vector2i(5, 3))
			for i in 3:
				_stamp_at(F_STOOL, o + Vector2i(3 + i * 2, 5))
			_stamp_at(R_BARREL, o + Vector2i(9, 2))
			_stamp_at(R_BARREL, o + Vector2i(10, 2))
			_stamp_at(R_BARREL, o + Vector2i(10, 3))
			_stamp_at(F_JAR, o + Vector2i(8, 2))
			_stamp_at(F_LAMP, o + Vector2i(1, 6))
		"library":
			for i in 5:
				_stamp_at(F_BOOKSHELF, o + Vector2i(2 + i, 2))
			for i in 3:
				_stamp_at(F_BOOKSHELF, o + Vector2i(9 + i, 2))
			_stamp_at(F_BIGSHELF, o + Vector2i(3, 5))
			_stamp_at(F_BIGSHELF, o + Vector2i(7, 5))
			_stamp_at(F_BIGSHELF, o + Vector2i(11, 5))
			_stamp_at(F_TABLE, o + Vector2i(5, 8))
			_stamp_at(F_STOOL, o + Vector2i(6, 8))
			_stamp_at(F_PLANT, o + Vector2i(1, 8))
			_stamp_at(F_PLANT, o + Vector2i(14, 8))
		"shop":
			for i in 2:
				_stamp_at(F_SHELF, o + Vector2i(2 + i, 2))
			for i in 2:
				_stamp_at(F_SHELF, o + Vector2i(5 + i, 2))
			_stamp_at(F_CABINET, o + Vector2i(8, 2))
			_stamp_at(R_BASKET, o + Vector2i(9, 3))
			_stamp_at(R_BARREL, o + Vector2i(10, 3))
			_stamp_at(F_COUNTER, o + Vector2i(3, 5))
			_stamp_at(F_PLANT, o + Vector2i(1, 5))
		"bakery":
			_stamp_at(F_COUNTER, o + Vector2i(2, 3))
			_stamp_at(F_COUNTER, o + Vector2i(5, 3))
			_stamp_at(R_BREAD, o + Vector2i(3, 2))
			_stamp_at(R_BREAD, o + Vector2i(5, 2))
			_stamp_at(R_BASKET, o + Vector2i(7, 2))
			_stamp_at(F_JAR, o + Vector2i(9, 2))
			_stamp_at(F_LAMP, o + Vector2i(10, 6))
			_stamp_at(F_PLANT, o + Vector2i(1, 6))
		"flower_shop":
			for c in [Vector2i(2, 2), Vector2i(3, 2), Vector2i(5, 2), Vector2i(6, 2), Vector2i(8, 2), Vector2i(2, 5), Vector2i(4, 5)]:
				_stamp_at(F_PLANT, o + c)
			_stamp_at(F_JAR, o + Vector2i(9, 2))
			_stamp_at(F_COUNTER, o + Vector2i(6, 5))
		_:
			# 住宅通用：床 + 三格地毯 + 个性家具 + 灯
			var bed: Array = BEDS.get(spec.get("bed", "tan"), BEDS["tan"])
			_stamp_at(bed, o + Vector2i(2, 2))
			_stamp_at(F_RUG3, o + Vector2i(4, 3))
			var extra: Array = spec.get("extra", F_DRAWER)
			_stamp_at(extra, o + Vector2i(sz.x - 3, 2))
			_stamp_at(F_LAMP, o + Vector2i(sz.x - 2, 5))

# ---------------- 未知地点兜底 ----------------

func _fallback_stand() -> Vector2i:
	var s := Vector2i(4 + (_fallback_i % 14) * 4, 28)
	_fallback_i += 1
	return s
