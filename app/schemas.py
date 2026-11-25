from pydantic import BaseModel, Field


class TranscriptionCreate(BaseModel):
    text: str = Field(min_length=1)
    source: str = "microphone"


class TranscriptionUpdate(BaseModel):
    text: str = Field(min_length=1)