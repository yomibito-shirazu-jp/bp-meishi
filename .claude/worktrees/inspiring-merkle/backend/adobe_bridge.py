"""
Adobe Bridge — Socket.IO 経由で Adobe アプリ (Photoshop, InDesign, Illustrator) を操作

adb-mcp-main の socket_client.py パターンを再利用。
プロキシ (localhost:3001) に接続し、コマンドを送信→レスポンスを受け取る。
"""
from __future__ import annotations

import socketio
import json
import threading
from queue import Queue
from typing import Any

PROXY_URL = "http://localhost:3001"
PROXY_TIMEOUT = 60  # seconds


class AdobeBridge:
    """Adobe アプリへの Socket.IO ブリッジ"""

    def __init__(self, proxy_url: str = PROXY_URL, timeout: int = PROXY_TIMEOUT):
        self.proxy_url = proxy_url
        self.timeout = timeout

    def send_command(self, application: str, action: str, options: dict[str, Any] | None = None) -> dict[str, Any] | None:
        """
        Adobe アプリにコマンドを送信し、レスポンスを待つ (blocking)。

        Args:
            application: "photoshop" | "indesign" | "illustrator" | "premierepro" | "aftereffects"
            action: コマンド名 (例: "createDocument", "editTextLayer")
            options: コマンドパラメータ
        Returns:
            レスポンス dict or None
        """
        command = {
            "application": application,
            "action": action,
            "options": options or {},
        }

        sio = socketio.Client(logger=False)
        response_queue: Queue[dict | None] = Queue()
        connection_failed = [False]

        @sio.event
        def connect():
            sio.emit("command_packet", {
                "type": "command",
                "application": application,
                "command": command,
            })

        @sio.event
        def packet_response(data):
            response_queue.put(data)
            sio.disconnect()

        @sio.event
        def disconnect():
            if response_queue.empty():
                response_queue.put(None)

        @sio.event
        def connect_error(error):
            connection_failed[0] = True
            response_queue.put(None)

        def connect_and_wait():
            try:
                sio.connect(self.proxy_url, transports=["websocket"])
                sio.wait()
            except Exception:
                connection_failed[0] = True
                if response_queue.empty():
                    response_queue.put(None)
                if sio.connected:
                    sio.disconnect()

        client_thread = threading.Thread(target=connect_and_wait, daemon=True)
        client_thread.start()

        try:
            response = response_queue.get(timeout=self.timeout)
            if connection_failed[0]:
                raise ConnectionError(
                    f"Adobe プロキシ ({self.proxy_url}) に接続できません。"
                    f"プロキシサーバーが起動しているか確認してください。"
                )
            if response and response.get("status") == "FAILURE":
                raise RuntimeError(f"Adobe {application} エラー: {response.get('message', 'unknown')}")
            return response
        except Exception as e:
            if sio.connected:
                sio.disconnect()
            raise
        finally:
            if sio.connected:
                sio.disconnect()
            client_thread.join(timeout=1)

    def check_connection(self) -> bool:
        """プロキシへの接続テスト"""
        try:
            sio = socketio.Client(logger=False)
            connected = [False]

            @sio.event
            def connect():
                connected[0] = True
                sio.disconnect()

            @sio.event
            def connect_error(error):
                pass

            thread = threading.Thread(
                target=lambda: sio.connect(self.proxy_url, transports=["websocket"]),
                daemon=True,
            )
            thread.start()
            thread.join(timeout=5)
            return connected[0]
        except Exception:
            return False

    # ── Photoshop convenience methods ──

    def ps_open_document(self, file_path: str) -> dict | None:
        return self.send_command("photoshop", "openDocument", {"filePath": file_path})

    def ps_save_document(self, file_path: str = "") -> dict | None:
        opts = {"filePath": file_path} if file_path else {}
        return self.send_command("photoshop", "saveDocument", opts)

    def ps_get_document_image(self) -> dict | None:
        """ドキュメント全体の JPEG プレビューを取得"""
        return self.send_command("photoshop", "getDocumentImage", {})

    def ps_create_text_layer(self, text: str, font_size: int = 12, font_name: str = "NotoSansJP-Regular",
                              color: dict | None = None, position: dict | None = None) -> dict | None:
        return self.send_command("photoshop", "createTextLayer", {
            "text": text,
            "fontSize": font_size,
            "fontName": font_name,
            "color": color or {"red": 0, "green": 0, "blue": 0},
            **({"position": position} if position else {}),
        })

    def ps_edit_text_layer(self, layer_name: str, text: str) -> dict | None:
        return self.send_command("photoshop", "editTextLayer", {
            "layerName": layer_name,
            "text": text,
        })

    def ps_save_as_png(self, file_path: str) -> dict | None:
        return self.send_command("photoshop", "saveDocumentAsPng", {"filePath": file_path})

    def ps_get_layers(self) -> dict | None:
        return self.send_command("photoshop", "getDocumentLayers", {})

    def ps_generative_fill(self, prompt: str) -> dict | None:
        return self.send_command("photoshop", "generativeFill", {"prompt": prompt})

    # ── InDesign convenience methods ──

    def id_create_document(self, width: int = 210, height: int = 297, margins: int = 10) -> dict | None:
        return self.send_command("indesign", "createDocument", {
            "width": width, "height": height, "margins": margins,
        })

    # ── Illustrator convenience methods ──

    def ai_execute_script(self, script: str) -> dict | None:
        return self.send_command("illustrator", "executeScript", {"script": script})

    def ai_get_document_info(self) -> dict | None:
        return self.send_command("illustrator", "getDocumentInfo", {})

    def ai_export_png(self, file_path: str) -> dict | None:
        return self.send_command("illustrator", "exportPng", {"filePath": file_path})


# Singleton instance
adobe = AdobeBridge()
