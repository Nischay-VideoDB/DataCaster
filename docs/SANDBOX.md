# VideoDB Hackathon Sandbox — Reference

Source: https://hackday.videodb.io/sandbox.html

This document is the authoritative quick-reference for the VideoDB hackathon sandbox runtime. Use it whenever building, testing, or debugging code in this repo.

---

## 1. Install (hackathon branch only)

The hackathon ships a special branch of the SDK. **Do not** install the public PyPI `videodb` package — `sandbox_id`, `SandboxTier`, and other params don't exist there.

```shell
pip install "git+https://github.com/Video-DB/videodb-python.git@hackathon"
```

## 2. Authentication

Standard `videodb.connect()` — picks up the API key from the environment.

```python
from videodb import connect, SandboxTier
from videodb._constants import SceneExtractionType

conn = connect()                # reads VIDEO_DB_API_KEY from env
coll = conn.get_collection()
```

The API key is stored at the repo root in `.env` as `VIDEO_DB_API_KEY` (gitignored).

---

## 3. Sandbox lifecycle

Every run follows this pattern:

```python
# 1. create
sandbox = conn.create_sandbox(
    tier=SandboxTier.medium,
    idle_timeout=600,           # auto-stop after 10 min of inactivity
)

# 2. wait until active
sandbox.wait_for_ready(timeout=300, interval=5)
assert sandbox.is_active        # or: sandbox.status == "active"

# 3. pass sandbox.id to every workload call below

# 4. inspect / list (optional)
sandbox.refresh()
conn.list_sandboxes()
conn.get_sandbox(sandbox.id)

# 5. stop when done — credits keep burning otherwise
sandbox.stop()
sandbox.wait_for_stop(timeout=120)
```

**Always stop the sandbox in a `finally:` block.** `idle_timeout` is the safety net, not the primary mechanism.

```python
try:
    sandbox = conn.create_sandbox(tier=SandboxTier.small, idle_timeout=600)
    sandbox.wait_for_ready()
    # ... workload ...
finally:
    sandbox.stop()
    sandbox.wait_for_stop()
```

**Reuse one sandbox per session/workflow** for compatible jobs. Don't spin up a new sandbox per call.

---

## 4. Tiers, cost, and concurrency

Hackathon credit pool: **$1,000 per team**.

| Tier   | Cost     | Concurrent jobs | Use for                                           |
|--------|----------|-----------------|---------------------------------------------------|
| small  | $1/hr    | 4               | Whisper, OmniVoice TTS, Qwen3.5-9B, Gemma-2B, Stable Audio |
| medium | $3.50/hr | 2               | Gemma-31B, Qwen3.5-27B, FLUX.1-dev                |

Pick tier by the **heaviest** model in the workflow.

Rough envelope: $1,000 ≈ **285 hr medium** or **1000 hr small**. Plenty *if* sandboxes don't sit idle.

---

## 5. Supported models

| Model                                  | Type                  | Tier   |
|----------------------------------------|-----------------------|--------|
| `google/gemma-4-31B-it`                | Multimodal            | medium |
| `google/gemma-4-26B-A4B-it`            | MoE                   | medium |
| `google/gemma-4-E2B-it`                | 2B multimodal         | small  |
| `Qwen/Qwen3.5-9B`                      | Text + thinking       | small  |
| `Qwen/Qwen3.5-27B`                     | Text + thinking       | medium |
| `openai/whisper-large-v3-turbo`        | Speech-to-text        | small  |
| `k2-fsa/OmniVoice`                     | TTS, 646 languages    | small  |
| `black-forest-labs/FLUX.1-dev`         | Text-to-image         | medium |
| `stabilityai/stable-audio-open-1.0`    | Text-to-audio         | small  |

---

## 6. Workload APIs

### 6.1 Scene indexing (uploaded video / YouTube)

```python
index_id = video.index_scenes(
    extraction_type=SceneExtractionType.time_based,
    extraction_config={
        "time": 10,
        "select_frames": ["first"],
        "frame_count": 1,
    },
    model_name="google/gemma-4-31B-it",
    prompt="Extract the text from this image and only return the text on screen.",
    sandbox_id=sandbox.id,
)
idx = video.get_scene_index(index_id)
```

### 6.2 RTStream — visual indexing (live)

```python
rtstream = coll.connect_rtstream(
    url="rtsp://your-camera-or-stream-url",
    name="Hackathon Live Stream",
    media_types=["video"],
    store=True,
)
rtstream.start()

visual_index = rtstream.index_visuals(
    prompt="Describe what is happening in the live video.",
    batch_config={"type": "time", "value": 5, "frame_count": 3},
    model_name="google/gemma-4-31B-it",
    sandbox_id=sandbox.id,
    name="live_visual_index",
)
```

### 6.3 RTStream — audio indexing (live)

```python
audio_index = rtstream.index_audio(
    prompt="Summarize the important spoken content and events.",
    batch_config={"type": "time", "value": 30},
    model_name="Qwen/Qwen3.5-9B",
    sandbox_id=sandbox.id,
    name="live_audio_index",
)
rtstream.stop()
```

### 6.4 OmniVoice TTS — basic

```python
job = coll.generate_voice(
    text="Hello, welcome to VideoDB.",
    model_name="k2-fsa/OmniVoice",
    sandbox_id=sandbox.id,
)
audio = job.wait(timeout=900, interval=5)
```

### 6.5 OmniVoice TTS — voice design (instructions)

```python
job = coll.generate_voice(
    text="Breaking news! Scientists discover a new planet.",
    model_name="k2-fsa/OmniVoice",
    sandbox_id=sandbox.id,
    config={"instructions": "A deep, authoritative male news anchor voice"},
)
```

### 6.6 OmniVoice TTS — voice clone

```python
ref_audio = coll.upload(
    url="https://www.youtube.com/shorts/7xOPzBhHKWY",
    media_type="audio",
)
job = coll.generate_voice(
    text="This is a cloned voice powered by OmniVoice.",
    model_name="k2-fsa/OmniVoice",
    sandbox_id=sandbox.id,
    config={
        "ref_audio": ref_audio.generate_url(),
        "ref_text": "Sample reference text for the audio clip",
    },
)
```

### 6.7 OmniVoice TTS — extra config (format / speed / language)

```python
job = coll.generate_voice(
    text="Hola, bienvenidos a VideoDB.",
    model_name="k2-fsa/OmniVoice",
    sandbox_id=sandbox.id,
    config={
        "response_format": "wav",
        "speed": 1.2,
        "language": "es",
    },
)
```

### 6.8 FLUX image generation — basic

```python
job = coll.generate_image(
    prompt="A futuristic cityscape at sunset, cyberpunk style",
    model_name="black-forest-labs/FLUX.1-dev",
    sandbox_id=sandbox.id,
)
image = job.wait(timeout=900, interval=5)
```

### 6.9 FLUX image generation — with config

```python
job = coll.generate_image(
    prompt="A photorealistic portrait of a robot reading a book in a cozy library",
    model_name="black-forest-labs/FLUX.1-dev",
    sandbox_id=sandbox.id,
    config={
        "size": "1024x1536",
        "num_inference_steps": 50,
        "guidance_scale": 4.0,
        "negative_prompt": "blurry, low quality, watermark",
    },
)
```

### 6.10 Combining generated assets into a playable stream

```python
from videodb.editor import Timeline, Track, Clip, ImageAsset, AudioAsset, Fit

image_job = coll.generate_image(
    prompt="A dramatic mountain landscape at dawn",
    model_name="black-forest-labs/FLUX.1-dev",
    sandbox_id=sandbox.id,
    config={"size": "1280x720", "num_inference_steps": 28},
)
image = image_job.wait(timeout=900, interval=5)

audio_job = coll.generate_voice(
    text="Witness the breathtaking beauty of dawn over the mountains.",
    model_name="k2-fsa/OmniVoice",
    sandbox_id=sandbox.id,
    config={"instructions": "female, young adult, calm and cinematic"},
)
audio = audio_job.wait(timeout=900, interval=5)

timeline = Timeline(conn)
timeline.resolution = "1280x720"
timeline.background = "#000000"

image_track = Track()
image_track.add_clip(0, Clip(asset=ImageAsset(id=image.id), duration=float(audio.length), fit=Fit.crop))

audio_track = Track()
audio_track.add_clip(0, Clip(asset=AudioAsset(id=audio.id), duration=float(audio.length)))

timeline.add_track(image_track)
timeline.add_track(audio_track)

stream_url = timeline.generate_stream()
player_url = f"https://console.videodb.io/player?url={stream_url}"
```

---

## 7. Supported media inputs

- Live RTSP / RTMP capture streams
- Uploaded files
- YouTube links
- HTTP(S) M3U8 streams

---

## 8. Best practices

- Create one sandbox per session/workflow; reuse for compatible jobs.
- Wait for `sandbox.is_active == True` before submitting any job.
- Pass `sandbox_id=sandbox.id` explicitly to **every** workload call.
- Select tier by the heaviest model in the workflow.
- Use `job.wait(timeout=900, interval=5)` for long-running operations; bump timeout for chains.
- Stop the sandbox in a `finally:` block to conserve credits.
- Log `sandbox.id` for debugging and retries.

---

## 9. Support

- Email: team@videodb.io
- Discord: https://discord.gg/CqkZcEh3P
- Docs: https://docs.videodb.io
- Console: https://console.videodb.io
