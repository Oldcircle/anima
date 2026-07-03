extends Node
## Anima 后端 WebSocket 客户端（P0）
##
## 连 ws://localhost:3001（与现有 web/ HTML 面板同一条流），
## 把后端下行消息解析成信号广播出去。后端消息定义见 src/api/server.ts。

signal connected
signal disconnected
signal snapshot(data: Dictionary)
signal tick(data: Dictionary)
signal beat_ready(data: Dictionary)
signal character_detail(data: Dictionary)

@export var url: String = "ws://localhost:3001"
@export var reconnect_delay: float = 2.0

var _ws := WebSocketPeer.new()
var _last_state: int = WebSocketPeer.STATE_CLOSED
var _reconnect_timer: float = 0.0

func _ready() -> void:
	_open()

func _open() -> void:
	var err := _ws.connect_to_url(url)
	if err != OK:
		push_warning("[Net] connect_to_url(%s) failed: %d" % [url, err])

func _process(delta: float) -> void:
	_ws.poll()
	var state := _ws.get_ready_state()

	if state == WebSocketPeer.STATE_OPEN:
		if _last_state != WebSocketPeer.STATE_OPEN:
			print("[Net] connected → ", url)
			connected.emit()
		while _ws.get_available_packet_count() > 0:
			_handle_text(_ws.get_packet().get_string_from_utf8())

	elif state == WebSocketPeer.STATE_CLOSED:
		if _last_state != WebSocketPeer.STATE_CLOSED:
			print("[Net] closed (code=%d) — 后端没起？" % _ws.get_close_code())
			disconnected.emit()
		_reconnect_timer += delta
		if _reconnect_timer >= reconnect_delay:
			_reconnect_timer = 0.0
			print("[Net] reconnecting…")
			_ws = WebSocketPeer.new()
			_open()

	_last_state = state

func _handle_text(txt: String) -> void:
	var msg = JSON.parse_string(txt)
	if typeof(msg) != TYPE_DICTIONARY:
		push_warning("[Net] non-dict message: %s" % txt.substr(0, 80))
		return
	var data: Dictionary = msg.get("data", {})
	match msg.get("type", ""):
		"snapshot": snapshot.emit(data)
		"tick": tick.emit(data)
		"beat_ready": beat_ready.emit(data)
		"character_detail": character_detail.emit(data)
		"speed_changed": pass
		_: pass

## ── 上行（P2+ 用）──

func request_character(id: String) -> void:
	_send({"type": "get_character", "data": {"id": id}})

func set_speed(speed: float) -> void:
	_send({"type": "set_speed", "data": {"speed": speed}})

func _send(obj: Dictionary) -> void:
	if _ws.get_ready_state() == WebSocketPeer.STATE_OPEN:
		_ws.send_text(JSON.stringify(obj))
