import asyncio
import json
import os
import traceback
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

import aiohttp
from dotenv import load_dotenv
from fastapi import (
    FastAPI,
    WebSocket,
    WebSocketDisconnect,
    UploadFile,
    File,
    HTTPException,
    Depends,
)
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from app.db import (
    create_database,
    get_db,
    Transcription,
)
from app.schemas import (
    TranscriptionCreate,
    TranscriptionUpdate,
)
from app.gemini import transcribe_uploaded_file


load_dotenv()

ASSEMBLYAI_API_KEY = os.getenv("ASSEMBLYAI_API_KEY")
ASSEMBLYAI_MODEL = os.getenv("ASSEMBLYAI_SPEECH_MODEL", "universal-3-6-pro")

ASSEMBLYAI_URL = "wss://streaming.assemblyai.com/v3/ws?" + urlencode(
    {
        "speech_model": ASSEMBLYAI_MODEL,
        "sample_rate": 16000,
    }
)


app = FastAPI(title="Speech to Text")

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"


@app.on_event("startup")
def startup():
    create_database()


app.mount(
    "/static",
    StaticFiles(directory=STATIC_DIR),
    name="static",
)


# --------------------- Homepage --------------------------

@app.get("/")
def home():
    return FileResponse(STATIC_DIR / "index.html")


# ------------------------ CREATE transcription ------------------------------

@app.post("/api/transcriptions")
def create_transcription(
    data: TranscriptionCreate,
    db: Session = Depends(get_db),
):
    transcript = Transcription(
        text=data.text,
        source=data.source,
    )

    db.add(transcript)
    db.commit()
    db.refresh(transcript)

    return transcript


# -------------------------------- READ transcriptions --------------------------------

@app.get("/api/transcriptions")
def get_transcriptions(
    db: Session = Depends(get_db),
):
    return (
        db.query(Transcription)
        .order_by(Transcription.created_at.desc())
        .all()
    )


# -------------------------------- READ transcription --------------------------------

@app.get("/api/transcriptions/{transcription_id}")
def get_transcription(
    transcription_id: int,
    db: Session = Depends(get_db),
):
    transcript = db.get(Transcription, transcription_id)

    if not transcript:
        raise HTTPException(status_code=404, detail="Transcription not found")

    return transcript


# -------------------------------- UPDATE transcription --------------------------------

@app.put("/api/transcriptions/{transcription_id}")
def update_transcription(
    transcription_id: int,
    data: TranscriptionUpdate,
    db: Session = Depends(get_db),
):
    transcript = db.get(Transcription, transcription_id)

    if not transcript:
        raise HTTPException(status_code=404, detail="Transcription not found")

    transcript.text = data.text
    transcript.updated_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(transcript)

    return transcript


# -------------------------------- DELETE transcription  --------------------------------

@app.delete("/api/transcriptions/{transcription_id}")
def delete_transcription(
    transcription_id: int,
    db: Session = Depends(get_db),
):
    transcript = db.get(Transcription, transcription_id)

    if not transcript:
        raise HTTPException(status_code=404, detail="Transcription not found")

    db.delete(transcript)
    db.commit()

    return {"message": "Transcription deleted"}




ALLOWED_TYPES = {
    "audio/mpeg",
    "audio/wav",
    "audio/x-wav",
    "audio/mp4",
    "audio/x-m4a",
    "audio/webm",
    "audio/ogg",
}

MAX_FILE_SIZE = 15 * 1024 * 1024


@app.post("/api/transcriptions/upload")
async def upload_audio(
    file: UploadFile = File(...),
):
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail="Unsupported audio format")

    audio_bytes = await file.read()

    if not audio_bytes:
        raise HTTPException(status_code=400, detail="The uploaded file is empty")

    if len(audio_bytes) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="Maximum file size is 15 MB")

    try:
        text = await asyncio.to_thread(
            transcribe_uploaded_file,
            audio_bytes,
            file.filename or "audio.wav",
            file.content_type,
        )

        return {"text": text, "source": "upload"}

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {str(error)}",
        )


# -------------------------------- LIVE transcription WebSocket (AssemblyAI) --------------------------------

@app.websocket("/ws/transcribe")
async def live_transcription(websocket: WebSocket):
    await websocket.accept()

    if not ASSEMBLYAI_API_KEY:
        await websocket.send_json({
            "type": "error",
            "message": "ASSEMBLYAI_API_KEY is missing in .env",
        })
        await websocket.close()
        return

    try:
        async with aiohttp.ClientSession() as http:
            async with http.ws_connect(
                ASSEMBLYAI_URL,
                headers={"Authorization": ASSEMBLYAI_API_KEY},
                heartbeat=20,
            ) as aai:

                async def browser_to_assemblyai():
                    while True:
                        message = await websocket.receive()

                        if message["type"] == "websocket.disconnect":
                            break

                        if message.get("bytes"):
                            await aai.send_bytes(message["bytes"])

                        elif message.get("text"):
                            data = json.loads(message["text"])
                            if data.get("type") == "stop":
                                break

                    # This will Ask AssemblyAI to finish and send last results
                    try:
                        await aai.send_json({"type": "Terminate"})
                    except Exception:
                        pass

                async def assemblyai_to_browser():
                    turn_counter = 0

                    async for message in aai:
                        if message.type != aiohttp.WSMsgType.TEXT:
                            continue

                        data = json.loads(message.data)
                        kind = data.get("type")

                        if kind == "Begin":
                            await websocket.send_json({"type": "ready"})

                        elif kind == "Turn":
                            order = data.get("turn_order", turn_counter)

                            await websocket.send_json({
                                "type": "turn",
                                "order": order,
                                "text": data.get("transcript", ""),
                            })

                            if data.get("end_of_turn"):
                                turn_counter += 1

                        elif kind == "Termination":
                            break

                        elif data.get("error"):
                            await websocket.send_json({
                                "type": "error",
                                "message": f"AssemblyAI: {data['error']}",
                            })

                sender = asyncio.create_task(browser_to_assemblyai())
                receiver = asyncio.create_task(assemblyai_to_browser())

                await asyncio.wait(
                    {sender, receiver},
                    return_when=asyncio.FIRST_COMPLETED,
                )

                #  When User pressed stop: it gives  AssemblyAI a moment to send the last words
                if sender.done() and not receiver.done():
                    try:
                        await asyncio.wait_for(asyncio.shield(receiver), timeout=3)
                    except (asyncio.TimeoutError, asyncio.CancelledError):
                        pass

                for task in (sender, receiver):
                    if not task.done():
                        task.cancel()

                for task in (sender, receiver):
                    try:
                        await task
                    except (asyncio.CancelledError, WebSocketDisconnect):
                        pass

    except WebSocketDisconnect:
        pass

    except Exception as error:
        traceback.print_exc()

        try:
            await websocket.send_json({
                "type": "error",
                "message": f"Live transcription failed: {error}",
            })
        except Exception:
            pass

    finally:
        try:
            await websocket.close()
        except Exception:
            pass