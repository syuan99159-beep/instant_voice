from __future__ import annotations

from functools import lru_cache
import json
from pathlib import Path
from typing import Any
import traceback
import time

from flask import Flask, jsonify, render_template, request
import uuid
import math

# faster-whisper optional import
try:
    from faster_whisper import WhisperModel
except Exception:  # pragma: no cover - optional dependency
    WhisperModel = None

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
STATIC_DIR = BASE_DIR / "static"
SUTRAS_FILE = DATA_DIR / "sutras.json"
TEMP_AUDIO_DIR = BASE_DIR / "temp_audio"
MODEL_SIZE = "tiny"  # 可改為 "base" 以提高準確度
_WHISPER_MODEL = None


def get_whisper_model():
    global _WHISPER_MODEL
    if _WHISPER_MODEL is not None:
        return _WHISPER_MODEL

    if WhisperModel is None:
        return None

    try:
        # 載入模型到 CPU，若有 CUDA 可改為 device='cuda'
        _WHISPER_MODEL = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
        return _WHISPER_MODEL
    except Exception:
        _WHISPER_MODEL = None
        return None


WHISPER_MODEL = get_whisper_model()

app = Flask(__name__, static_folder="static", template_folder="templates")


def load_json_file(path: Path, default: Any) -> Any:
    try:
        with path.open("r", encoding="utf-8") as file_handle:
            return json.load(file_handle)
    except FileNotFoundError:
        return default
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid JSON in {path}") from error


def safe_join_static_url(url_path: str) -> str:
    if not url_path:
        return ""
    return url_path if url_path.startswith("/") else f"/{url_path.lstrip('/')}"


@lru_cache(maxsize=1)
def get_sutras() -> list[dict[str, Any]]:
    raw_items = load_json_file(SUTRAS_FILE, [])
    sutras: list[dict[str, Any]] = []

    for item in raw_items:
        sutra_id = str(item.get("id", "")).strip()
        if not sutra_id:
            continue

        sutras.append(
            {
                "id": sutra_id,
                "title": str(item.get("title", sutra_id)).strip(),
                "audio": safe_join_static_url(str(item.get("audio", ""))),
                "subtitle": safe_join_static_url(str(item.get("subtitle", ""))),
            }
        )

    return sutras


def find_sutra(sutra_id: str) -> dict[str, Any] | None:
    return next((sutra for sutra in get_sutras() if sutra["id"] == sutra_id), None)


def resolve_subtitle_path(subtitle_url: str) -> Path:
    if subtitle_url.startswith("/static/"):
        return BASE_DIR / subtitle_url.lstrip("/")
    if subtitle_url.startswith("static/"):
        return BASE_DIR / subtitle_url
    return BASE_DIR / subtitle_url.lstrip("/")


@app.route("/")
def index() -> str:
    sutras = get_sutras()
    default_sutra_id = sutras[0]["id"] if sutras else ""
    return render_template("index.html", default_sutra_id=default_sutra_id)


@app.get("/api/sutras")
def api_sutras():
    return jsonify({"sutras": get_sutras()})


@app.get("/api/sutras/<sutra_id>")
def api_sutra_detail(sutra_id: str):
    sutra = find_sutra(sutra_id)
    if sutra is None:
        return jsonify({"error": "Sutra not found"}), 404

    subtitle_path = resolve_subtitle_path(sutra["subtitle"])
    subtitles = load_json_file(subtitle_path, [])

    return jsonify(
        {
            "sutra": sutra,
            "subtitles": subtitles,
        }
    )


@app.errorhandler(404)
def not_found(_error):
    return jsonify({"error": "Not found"}), 404


@app.errorhandler(500)
def internal_error(_error):
    return jsonify({"error": "Server error"}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", debug=True, port=5002)


@app.post('/api/voice-command')
def api_voice_command():
    """接收前端上傳的錄音檔，暫存，並回傳 mock 辨識結果。

    - 接收 multipart/form-data 的音檔欄位 (file)
    - 將檔案寫入 `temp_audio/`，檔名為 uuid + 原始副檔名
    - (預留 Whisper 辨識整合位置)
    - 回傳暫時的 mock JSON
    """
    def error_response(message: str, status_code: int = 200, **extra: Any):
        payload = {"success": False, "error": message}
        if extra:
            payload.update(extra)
        return jsonify(payload), status_code

    overall_start = time.perf_counter()

    try:
        save_start = time.perf_counter()
        TEMP_AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        traceback.print_exc()
        return error_response(f"Unable to create temp directory: {exc}")

    file_storage = request.files.get('file') or request.files.get('audio')
    if file_storage is None or not getattr(file_storage, 'filename', ''):
        return error_response("No audio file uploaded", 400)

    suffix = Path(file_storage.filename).suffix or '.webm'
    dest_name = f"{uuid.uuid4().hex}{suffix}"
    dest_path = TEMP_AUDIO_DIR / dest_name

    try:
        file_storage.save(dest_path)
        save_elapsed = time.perf_counter() - save_start
        print(f"[voice-command] save audio: {save_elapsed:.3f}s")
    except Exception as exc:
        traceback.print_exc()
        return error_response(f"Failed to save uploaded audio: {exc}")

    def map_text_to_command(text: str) -> str:
        if not text:
            return "unknown"

        t = text.strip().lower()

        mapping = [
            (("播放", "繼續"), "play"),
            (("暫停", "停止"), "pause"),
            (("下一句",), "next"),
            (("上一句",), "previous"),
            (("重播",), "restart"),
            (("循環播放",), "loop_on"),
            (("取消循環",), "loop_off"),
            (("快一點", "快點"), "speed_up"),
            (("慢一點", "慢點"), "speed_down"),
        ]

        for keys, cmd in mapping:
            for k in keys:
                if k in t:
                    return cmd

        return "unknown"

    transcript_text = ""
    confidence = 0.0
    command_parse_start = time.perf_counter()

    try:
        model = WHISPER_MODEL
    except Exception as exc:
        traceback.print_exc()
        return error_response(f"Failed to access speech model: {exc}")

    if model is None:
        # 模型不可用，回傳 unknown 同時提示前端
        transcript_text = ""
        command = "unknown"
        command_parse_elapsed = time.perf_counter() - command_parse_start
        overall_elapsed = time.perf_counter() - overall_start
        print(f"[voice-command] command parse: {command_parse_elapsed:.3f}s")
        print(f"[voice-command] total: {overall_elapsed:.3f}s")
        return jsonify({"ok": False, "text": transcript_text, "command": command, "error": "Speech model unavailable"}), 200

    try:
        whisper_start = time.perf_counter()
        # faster-whisper 支援透過 ffmpeg 自動處理多數音訊格式
        segments, info = model.transcribe(str(dest_path), beam_size=1, language="zh", task="transcribe")
        whisper_elapsed = time.perf_counter() - whisper_start
        print(f"[voice-command] whisper infer: {whisper_elapsed:.3f}s")

        # 合併所有段落的文字
        parts = []
        confidences = []
        for seg in segments:
            # seg 可能是 dict 或物件
            seg_text = getattr(seg, 'text', None) or (seg.get('text') if isinstance(seg, dict) else '')
            parts.append(seg_text)

            # 嘗試取得 avg_logprob 或 confidence
            avg_logprob = None
            if isinstance(seg, dict):
                avg_logprob = seg.get('avg_logprob') or seg.get('confidence')
            else:
                avg_logprob = getattr(seg, 'avg_logprob', None) or getattr(seg, 'confidence', None)

            if avg_logprob is not None:
                try:
                    avg = float(avg_logprob)
                    confidences.append(avg)
                except Exception:
                    pass

        transcript_text = "".join(parts).strip()

        if confidences:
            # 將 avg_logprob (可能為負) 映射到 [0,1]，使用 sigmoid
            avg = sum(confidences) / len(confidences)
            try:
                confidence = float(1 / (1 + math.exp(-avg)))
            except Exception:
                confidence = 0.0
        else:
            # fallback heuristic
            confidence = 0.9 if transcript_text else 0.0

        command_parse_start = time.perf_counter()
        command = map_text_to_command(transcript_text)
        command_parse_elapsed = time.perf_counter() - command_parse_start
        overall_elapsed = time.perf_counter() - overall_start
        print(f"[voice-command] command parse: {command_parse_elapsed:.3f}s")
        print(f"[voice-command] total: {overall_elapsed:.3f}s")

        return jsonify({"ok": True, "text": transcript_text, "command": command, "error": ""}), 200

    except Exception as exc:  # pragma: no cover - runtime errors handled
        # 若辨識失敗，不讓前端卡死，回傳 unknown
        traceback.print_exc()
        overall_elapsed = time.perf_counter() - overall_start
        print(f"[voice-command] total: {overall_elapsed:.3f}s")
        return error_response(str(exc), 200, ok=False, text="", command="unknown")
