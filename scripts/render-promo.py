#!/usr/bin/env python3
"""Render a narrated Pixel Office film from the local demo browser capture.

Run ``node scripts/capture-promo.mjs`` against ``npx tsx e2e/server.ts`` first.
Requires macOS ``say``, Pillow, and ffmpeg (or imageio-ffmpeg).
"""

from __future__ import annotations

from array import array
from bisect import bisect_right
import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
import wave

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / ".pixel" / "promo-source"
OUTPUT = ROOT / "docs" / "promo" / "pixel-office-promo.mp4"
W, H, FPS, SAMPLE_RATE = 1280, 720, 25, 44100
FONT_PATH = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
HERO = ImageFont.truetype(FONT_PATH, 71)
TITLE = ImageFont.truetype(FONT_PATH, 49)
CAPTION = ImageFont.truetype(FONT_PATH, 30)
BODY = ImageFont.truetype(FONT_PATH, 25)
SMALL = ImageFont.truetype(FONT_PATH, 18)
MONO = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 21)
INK = "#102c23"
MINT = "#c8e2cb"
IVORY = "#f8f5ec"
GOLD = "#f2d285"

SCENES = [
    {"kind": "intro", "seconds": 3.6, "voice": "터미널은 여러 곳에 흩어져 있죠.", "subtitle": "터미널은 여러 곳에 흩어져 있죠."},
    {"kind": "map", "seconds": 7.5, "start": "map", "end": "web", "voice": "픽셀 오피스는 이 맥의 클로드 코드와 코덱스 세션을 찾아, 프로젝트별로 모아줍니다.", "subtitle": "이 Mac의 Claude Code와 Codex 세션을 찾아, 프로젝트별로 모아줍니다."},
    {"kind": "history", "seconds": 5.0, "start": "web", "end": "question", "voice": "동료를 누르면 최근 작업과 실행한 명령이 보이고,", "subtitle": "동료를 누르면 최근 작업과 실행한 명령이 보이고,"},
    {"kind": "ask", "seconds": 5.2, "start": "question", "end": "map_again", "voice": "선택한 세션의 작업 기록에 바로 질문할 수 있습니다.", "subtitle": "선택한 세션의 작업 기록에 바로 질문할 수 있습니다."},
    {"kind": "second", "seconds": 5.2, "start": "map_again", "end": "end", "voice": "다른 프로젝트의 동료에게도, 같은 방식으로 물어보세요.", "subtitle": "다른 프로젝트의 동료에게도, 같은 방식으로 물어보세요."},
    {"kind": "outro", "seconds": 4.7, "voice": "흩어진 터미널을 하나의 사무실로. 픽셀 오피스.", "subtitle": "흩어진 터미널을 하나의 사무실로. Pixel Office."},
]


def ffmpeg_exe() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def ease(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return 1 - (1 - value) ** 3


def interpolate(a: tuple[int, ...], b: tuple[int, ...], amount: float) -> tuple[int, ...]:
    return tuple(round(x + (y - x) * amount) for x, y in zip(a, b))


class Capture:
    def __init__(self) -> None:
        self.marks = {item["name"]: item["seconds"] for item in json.loads((SOURCE / "marks.json").read_text())}
        self.items = json.loads((SOURCE / "frames.json").read_text())
        self.times = [item["seconds"] for item in self.items]
        self.current_index = -1
        self.current: Image.Image | None = None

    def at(self, seconds: float) -> Image.Image:
        index = max(0, bisect_right(self.times, seconds) - 1)
        if index != self.current_index:
            self.current = Image.open(SOURCE / "frames" / f"{self.items[index]['index']:05d}.jpg").convert("RGB")
            self.current_index = index
        assert self.current is not None
        return self.current


def grid() -> Image.Image:
    canvas = Image.new("RGB", (W, H), "#0d281e")
    draw = ImageDraw.Draw(canvas)
    for x in range(0, W, 40):
        draw.line((x, 0, x, H), fill="#17382c", width=1)
    for y in range(0, H, 40):
        draw.line((0, y, W, y), fill="#17382c", width=1)
    return canvas


def terminal_card(canvas: Image.Image, bounds: tuple[int, int, int, int], label: str, content: str, light: str) -> None:
    x, y, width, height = bounds
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((x + 9, y + 16, x + width + 9, y + height + 16), radius=17, fill="#071d17")
    draw.rounded_rectangle((x, y, x + width, y + height), radius=17, fill="#1b3b30", outline="#50715b", width=2)
    draw.rounded_rectangle((x, y, x + width, y + 40), radius=17, fill="#2a4b3b")
    draw.rectangle((x, y + 22, x + width, y + 40), fill="#2a4b3b")
    for dot, color in enumerate(("#ec8f85", "#edc76d", "#a1c987")):
        draw.ellipse((x + 17 + dot * 21, y + 16, x + 26 + dot * 21, y + 25), fill=color)
    draw.text((x + 20, y + 55), label, font=SMALL, fill=MINT)
    draw.text((x + 20, y + 92), f"> {content}", font=MONO, fill=IVORY)
    draw.rectangle((x + 21, y + height - 26, x + 55, y + height - 21), fill=light)


def intro_frame(t: float) -> Image.Image:
    canvas = grid()
    cards = [
        ((66, 110, 470, 168), "~/web-app  ·  Codex", "npm test", GOLD, -520, 0.1),
        ((742, 128, 470, 168), "~/api-server  ·  Claude", "Read README.md", "#b9d6be", 570, 0.42),
        ((384, 332, 470, 168), "~/docs-site  ·  Codex", "git diff", "#d4afd4", 560, 0.75),
    ]
    for (x, y, width, height), label, content, color, offset, delay in cards:
        position = ease((t - delay) / 0.68)
        terminal_card(canvas, (round(x + offset * (1 - position)), y, width, height), label, content, color)
    draw = ImageDraw.Draw(canvas)
    draw.text((71, 39), "PIXEL OFFICE  /  LOCAL AI WORKSPACE", font=SMALL, fill=MINT)
    if t > 1.75:
        alpha = ease((t - 1.75) / 0.42)
        overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        panel = ImageDraw.Draw(overlay)
        panel.rounded_rectangle((65, 540, 970, 649), radius=22, fill=(11, 37, 27, round(240 * alpha)))
        panel.text((89, 552), "여러 터미널, 한눈에.", font=TITLE, fill=IVORY)
        canvas = Image.alpha_composite(canvas.convert("RGBA"), overlay).convert("RGB")
    return canvas


def live_frame(scene: dict, capture: Capture, local: float, progress: float) -> Image.Image:
    start, end = capture.marks[scene["start"]], capture.marks[scene["end"]]
    source_time = start + min(1.0, local / scene["seconds"]) * (end - start)
    original = capture.at(source_time)
    kind = scene["kind"]
    full = (0, 45, 1440, 855)
    if kind == "map":
        crop = interpolate(full, (205, 65, 1425, 751), ease((local - 1.7) / 3.0))
    elif kind == "history":
        crop = interpolate(full, (680, 120, 1440, 548), ease((local - 0.55) / 0.92))
    elif kind == "ask":
        lower = (770, 375, 1440, 752)
        upper = (770, 270, 1440, 647)
        crop = interpolate(full, lower, ease(local / 0.55))
        crop = interpolate(crop, upper, ease((local - 2.35) / 1.35))
    else:
        target = (770, 260, 1440, 637)
        crop = interpolate(full, target, ease((local - 1.05) / 1.1))
    canvas = original.crop(crop).resize((W, H), Image.Resampling.LANCZOS).convert("RGBA")
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    labels = {
        "map": ("01 / 자동 발견", "프로젝트마다 모인 동료들"),
        "history": ("02 / 작업 맥락", "동료의 기록을 펼쳐보세요"),
        "ask": ("03 / 기록에 질문", "테스트 기록을 바로 확인"),
        "second": ("04 / 다른 프로젝트", "같은 자리에서 다시 질문"),
    }
    eyebrow, heading = labels[kind]
    draw.rounded_rectangle((28, 24, 553, 113), radius=18, fill=(13, 44, 31, 228))
    draw.rectangle((48, 44, 77, 48), fill=GOLD)
    draw.text((91, 32), eyebrow, font=SMALL, fill=GOLD)
    draw.text((47, 62), heading, font=CAPTION, fill=IVORY)
    draw.rounded_rectangle((1105, 27, 1250, 60), radius=11, fill=(13, 44, 31, 218))
    draw.text((1118, 32), "LIVE UI  ·  DEMO", font=SMALL, fill=IVORY)
    draw.rectangle((0, H - 5, round(W * progress), H), fill=GOLD)
    return Image.alpha_composite(canvas, overlay).convert("RGB")


def outro_frame(t: float, final_capture: Image.Image) -> Image.Image:
    photo = final_capture.crop((0, 45, 1440, 855)).resize((W, H), Image.Resampling.LANCZOS)
    photo = photo.filter(ImageFilter.GaussianBlur(9)).convert("RGBA")
    wash = Image.new("RGBA", (W, H), (9, 37, 27, 229))
    canvas = Image.alpha_composite(photo, wash)
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((78, 119, 138, 125), fill=GOLD)
    draw.text((78, 151), "PIXEL OFFICE", font=SMALL, fill=MINT)
    draw.text((71, 248), "흩어진 터미널을", font=HERO, fill=IVORY)
    draw.text((71, 347), "하나의 사무실로.", font=HERO, fill=IVORY)
    draw.text((80, 549), "github.com/seongyeon1/pixel-office", font=BODY, fill=MINT)
    for index in range(3):
        center = 1050 + index * 42
        glow = 1 + 0.3 * math.sin(t * 3 - index)
        size = round(15 * glow)
        draw.rounded_rectangle((center - size, 622 - size, center + size, 622 + size), radius=5, fill=GOLD if index == 1 else "#80b38f")
    return canvas.convert("RGB")


def wrap(text: str, font: ImageFont.FreeTypeFont, limit: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and font.getlength(candidate) > limit:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def subtitle_frame(frame: Image.Image, text: str, visible: bool, kind: str) -> Image.Image:
    if not visible:
        return frame
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    if kind in {"history", "ask", "second"}:
        lines = wrap(text, BODY, 504)
        top = H - (66 + len(lines) * 35)
        draw.rounded_rectangle((28, top, 580, H - 22), radius=18, fill=(8, 31, 23, 235))
        for index, line in enumerate(lines):
            draw.text((51, top + 18 + index * 35), line, font=BODY, fill=IVORY)
    else:
        lines = wrap(text, CAPTION, 1120)
        top = H - (91 if len(lines) == 1 else 128)
        draw.rounded_rectangle((36, top, W - 36, H - 23), radius=18, fill=(8, 31, 23, 231))
        for index, line in enumerate(lines):
            width = CAPTION.getlength(line)
            draw.text(((W - width) / 2, top + 16 + index * 39), line, font=CAPTION, fill=IVORY)
    return Image.alpha_composite(frame.convert("RGBA"), overlay).convert("RGB")


def make_voice(scene: dict, index: int, directory: Path, ffmpeg: str) -> array:
    aiff = directory / f"voice-{index}.aiff"
    wav = directory / f"voice-{index}.wav"
    subprocess.run(["say", "-v", "Flo (한국어(대한민국))", "-r", "190", "-o", str(aiff), scene["voice"]], check=True)
    subprocess.run([ffmpeg, "-y", "-v", "error", "-i", str(aiff), "-ar", str(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", str(wav)], check=True)
    with wave.open(str(wav), "rb") as input_file:
        samples = array("h")
        samples.frombytes(input_file.readframes(input_file.getnframes()))
    if len(samples) / SAMPLE_RATE > scene["seconds"] - 0.55:
        raise ValueError(f"Narration too long for scene {index}")
    return samples


def make_audio(path: Path, scenes: list[dict], voices: list[array]) -> None:
    total = round(sum(scene["seconds"] for scene in scenes) * SAMPLE_RATE)
    speech = array("h", [0]) * total
    scene_start = 0.0
    for scene, voice in zip(scenes, voices):
        offset = round((scene_start + 0.38) * SAMPLE_RATE)
        speech[offset : offset + len(voice)] = voice
        scene_start += scene["seconds"]
    chords = [(164.81, 196.0, 246.94), (130.81, 164.81, 196.0), (146.83, 185.0, 220.0), (130.81, 196.0, 261.63)]
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        block = array("h")
        for index in range(total):
            t = index / SAMPLE_RATE
            chord = chords[int(t / 3.2) % len(chords)]
            beat = t % 0.48
            note = chord[int(t / 0.48) % 3] * 2
            pluck = math.sin(2 * math.pi * note * t) * math.exp(-beat * 10)
            pad = sum(math.sin(2 * math.pi * frequency * t) for frequency in chord) / 3
            fade = max(0.0, min(1.0, t / 0.8, (total / SAMPLE_RATE - t) / 0.9))
            music = (0.047 * pluck + 0.025 * pad) * fade
            sample = max(-32768, min(32767, round(speech[index] * 1.28 + music * 32767)))
            block.append(sample)
            if len(block) >= SAMPLE_RATE:
                output.writeframes(block.tobytes())
                block = array("h")
        if block:
            output.writeframes(block.tobytes())


def main() -> None:
    capture = Capture()
    ffmpeg = ffmpeg_exe()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    frames_per_scene = [round(scene["seconds"] * FPS) for scene in SCENES]
    total_frames = sum(frames_per_scene)
    with tempfile.TemporaryDirectory() as directory_name:
        directory = Path(directory_name)
        voices = [make_voice(scene, index, directory, ffmpeg) for index, scene in enumerate(SCENES)]
        silent = directory / "silent.mp4"
        audio = directory / "sound.wav"
        encoder = subprocess.Popen(
            [ffmpeg, "-y", "-v", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", f"{W}x{H}", "-framerate", str(FPS), "-i", "-", "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(silent)],
            stdin=subprocess.PIPE,
        )
        assert encoder.stdin is not None
        written = 0
        final_capture = capture.at(capture.marks["end"])
        previous_last: Image.Image | None = None
        for scene, count in zip(SCENES, frames_per_scene):
            for index in range(count):
                local = index / FPS
                kind = scene["kind"]
                if kind == "intro":
                    frame = intro_frame(local)
                elif kind == "outro":
                    frame = outro_frame(local, final_capture)
                else:
                    frame = live_frame(scene, capture, local, written / total_frames)
                frame = subtitle_frame(frame, scene["subtitle"], 0.35 <= local <= scene["seconds"] - 0.16, kind)
                if previous_last is not None and index < 7:
                    frame = Image.blend(previous_last, frame, ease((index + 1) / 7))
                encoder.stdin.write(frame.tobytes())
                written += 1
            previous_last = frame
            print(f"rendered {kind}", flush=True)
        encoder.stdin.close()
        if encoder.wait() != 0:
            raise RuntimeError("Video encoding failed")
        make_audio(audio, SCENES, voices)
        subprocess.run(
            [ffmpeg, "-y", "-v", "error", "-i", str(silent), "-i", str(audio), "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", str(OUTPUT)],
            check=True,
        )
    print(f"created {OUTPUT} ({written / FPS:.2f}s)")


if __name__ == "__main__":
    main()
