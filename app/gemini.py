import os
import tempfile
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import types


load_dotenv()

API_KEY = os.getenv("GEMINI_API_KEY")

if not API_KEY:
    raise ValueError("GEMINI_API_KEY is missing in .env")

client = genai.Client(api_key=API_KEY)


# ------------------------ Upload audio file transcription -------------------------------

def transcribe_uploaded_file(audio_bytes, filename, mime_type):
    """
    Receive audio bytes and return the recognized text.
    """

    suffix = Path(filename).suffix or ".wav"

    # ---------------------- Save the uploaded audio temporarily -----------------------
    with tempfile.NamedTemporaryFile(
        suffix=suffix,
        delete=False,
    ) as temp_file:

        temp_file.write(audio_bytes)
        temp_path = temp_file.name

    try:
        # --------------------------- Upload the audio to Gemini-------------------
        audio_file = client.files.upload(
            file=temp_path,
            config=types.UploadFileConfig(
                mime_type=mime_type,
            ),
        )

        # --------------------------- Ask Gemini to transcribe the audio -----------------------
        response = client.models.generate_content(
            model="gemini-3.8-flash",
            contents=[
                audio_file,
                """
                Transcribe the spoken words in this audio.

                Preserve the original language.
                Support Hindi, English, and mixed Hindi-English speech.
                Do not translate the speech.
                Return only the transcription.
                """,
            ],
        )

        if not response.text:
            raise ValueError("Gemini returned an empty transcription.")

        return response.text.strip()

    finally:
        
        if os.path.exists(temp_path):
            os.remove(temp_path)