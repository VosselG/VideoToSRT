import sys
import json
import os
import torch
import whisper
import warnings
import datetime
import subprocess
import base64
import re
import wave
import numpy as np

warnings.filterwarnings("ignore")

# --- CONFIGURATION ---
if getattr(sys, 'frozen', False):
    # FROZEN (EXE) MODE
    # sys.executable is inside /backend/engine/engine.exe
    # We need to go up one level to find /backend/bin
    current_dir = os.path.dirname(sys.executable)
    BASE_DIR = os.path.abspath(os.path.join(current_dir, ".."))
else:
    # DEV (SCRIPT) MODE
    BASE_DIR = os.path.dirname(__file__)

BIN_DIR = os.path.join(BASE_DIR, "bin")
FFMPEG_PATH = os.path.join(BIN_DIR, "ffmpeg.exe")
FFPROBE_PATH = os.path.join(BIN_DIR, "ffprobe.exe")

os.environ["PATH"] += os.pathsep + BIN_DIR

MODEL_MAP = {
    "lightning": "tiny",
    "standard": "base",
    "enhanced": "small",
    "professional": "medium",
    "studio": "large"
}

current_model = None
loaded_model_name = None
loaded_device = None

# --- UTILS ---
def send_to_electron(type, message, data=None):
    payload = {"type": type, "message": message}
    if data: payload["data"] = data
    print(json.dumps(payload))
    sys.stdout.flush()

def _subprocess_no_window_kwargs():
    """
    Returns kwargs for subprocess.* calls that hide the console window on Windows.
    """
    kwargs = {}
    if os.name == "nt":
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 0  # SW_HIDE
        kwargs["startupinfo"] = si
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    return kwargs

def load_wav_mono_16k(wav_path):
    """
    Loads a 16 kHz mono 16-bit PCM WAV file into a float32 NumPy array in [-1, 1].
    This is used for the temp WAVs created by extract_audio_silent() to avoid
    calling ffmpeg again from Whisper.
    """
    with wave.open(wav_path, "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        n_frames = wf.getnframes()
        audio_bytes = wf.readframes(n_frames)

    # We expect: mono, 16-bit, 16 kHz
    if n_channels != 1 or sampwidth != 2 or framerate != 16000:
        raise ValueError(
            f"Unexpected WAV format: channels={n_channels}, "
            f"sampwidth={sampwidth}, framerate={framerate}"
        )

    audio_np = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    return audio_np

# --- MONKEYPATCH WHISPER'S LOAD_AUDIO TO USE OUR SILENT FFMPEG/WAV LOADER ---
import whisper.audio as whisper_audio
from whisper.audio import SAMPLE_RATE

def custom_load_audio(audio, sr: int = SAMPLE_RATE):
    """
    Replacement for whisper.audio.load_audio that:
    - Uses ffmpeg with hidden console windows for generic media.
    - Uses a direct WAV reader for 16kHz mono temp WAVs created by extract_audio_silent.
    """

    # If it's already an array-like, just convert to float32 mono.
    # (We don't route this through ffmpeg; Whisper will get raw audio.)
    if not isinstance(audio, str):
        arr = np.array(audio, dtype=np.float32)
        if arr.ndim == 2:  # stereo -> mono
            arr = arr.mean(axis=0)
        return arr

    # If this is our extracted temp WAV, load without ffmpeg.
    if audio.lower().endswith(".wav"):
        return load_wav_mono_16k(audio)

    # Generic path: use ffmpeg to decode (no console window)
    cmd = [
        FFMPEG_PATH,
        "-nostdin",
        "-hide_banner",
        "-loglevel", "error",
        "-i", audio,
        "-f", "s16le",
        "-acodec", "pcm_s16le",
        "-ac", "1",
        "-ar", str(sr),
        "-"
    ]

    kwargs = _subprocess_no_window_kwargs()
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        **kwargs
    )
    out, err = proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg error {proc.returncode}: {err.decode(errors='ignore')}"
        )

    audio_np = np.frombuffer(out, np.int16).astype(np.float32) / 32768.0
    return audio_np

# Apply monkeypatch so all Whisper transcribes go through our loader
whisper_audio.load_audio = custom_load_audio

def get_device(pref="auto"):
    if pref == "cpu": return "cpu"
    if pref == "cuda" and torch.cuda.is_available(): return "cuda"
    # Auto logic
    return "cuda" if torch.cuda.is_available() else "cpu"

def load_ai_model(model_alias, device_pref):
    global current_model, loaded_model_name, loaded_device
    
    real_name = MODEL_MAP.get(model_alias, "base")
    target_device = get_device(device_pref)

    # Check if we already have this model on this device
    if (current_model and 
        loaded_model_name == real_name and 
        loaded_device == target_device):
        return current_model

    send_to_electron("status", f"Loading AI Model: {model_alias.title()} ({target_device.upper()})...")
    try:
        current_model = whisper.load_model(real_name, device=target_device)
        loaded_model_name = real_name
        loaded_device = target_device
        send_to_electron("status", "Model Loaded. Ready.")
        return current_model
    except Exception as e:
        send_to_electron("error", f"Failed to load model: {str(e)}")
        return None

def format_timestamp(seconds, fmt="srt"):
    td = datetime.timedelta(seconds=seconds)
    total_seconds = int(td.total_seconds())
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60
    millis = int(td.microseconds / 1000)
    
    if fmt == "vtt":
        return f"{hours:02}:{minutes:02}:{secs:02}.{millis:03}"
    return f"{hours:02}:{minutes:02}:{secs:02},{millis:03}"

# --- HELPER: SILENT AUDIO EXTRACTION ---
def extract_audio_silent(video_path):
    """
    Extracts audio to a temp .wav file using FFmpeg with NO window.
    """
    import tempfile
    temp_dir = tempfile.gettempdir()
    temp_audio = os.path.join(temp_dir, f"v2s_temp_{os.getpid()}.wav")

    cmd = [
        FFMPEG_PATH, "-y", "-i", video_path,
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        temp_audio
    ]

    kwargs = _subprocess_no_window_kwargs()

    try:
        subprocess.check_call(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **kwargs
        )
        return temp_audio
    except:
        return None

# --- ANALYSIS ENGINE ----
def analyze_file(file_path):
    if not os.path.exists(file_path):
        send_to_electron("error", "File analysis failed: Not found")
        return

    # PREVENT CMD FLASHING
    kwargs = _subprocess_no_window_kwargs()

    # Simple audio-only detection by file extension
    ext = os.path.splitext(file_path)[1].lower()
    audio_exts = {'.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'}

    try:
        # 1. Get Duration via FFprobe
        cmd = [
            FFPROBE_PATH, "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", file_path
        ]

        duration_sec = float(subprocess.check_output(
            cmd,
            **kwargs
        ).decode().strip())

        m, s = divmod(int(duration_sec), 60)
        duration_str = f"{m:02}:{s:02}"

        b64_thumb = None

        # 2. Generate Thumbnail only for video-like files
        if ext not in audio_exts:
            try:
                timestamp = "00:00:01"
                cmd_thumb = [
                    FFMPEG_PATH, "-y", "-ss", timestamp, "-i", file_path,
                    "-vframes", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-"
                ]

                thumb_data = subprocess.check_output(
                    cmd_thumb,
                    stderr=subprocess.DEVNULL,
                    **kwargs
                )

                b64_thumb = "data:image/jpeg;base64," + base64.b64encode(thumb_data).decode('utf-8')
            except Exception:
                # Thumbnail failure should not break duration display
                b64_thumb = None

        send_to_electron("analysis-result", "Analyzed", {
            "path": file_path,
            "duration": duration_str,
            "thumbnail": b64_thumb
        })

    except Exception as e:
        send_to_electron("error", f"Analysis failed: {str(e)}")

# --- TEXT PROCESSING ---
def apply_profanity_filter(text):
    bad_words = ["fuck", "shit", "bitch", "asshole", "cunt", "dick"]
    for word in bad_words:
        pattern = re.compile(re.escape(word), re.IGNORECASE)
        text = pattern.sub("*" * len(word), text)
    return text

def generate_output(result, format_type, preset_mode, max_chars, max_lines, use_profanity):
    all_words = []
    for segment in result["segments"]:
        if "words" in segment: all_words.extend(segment["words"])
    
    if not all_words: return "", 0

    # --- SPECIAL PATH FOR TXT TRANSCRIPTS (Smart Paragraphs) ---
    if format_type == "txt":
        output_str = ""
        segments = result["segments"]
        for i, segment in enumerate(segments):
            text = segment["text"].strip()
            if use_profanity: text = apply_profanity_filter(text)
            
            output_str += text
            
            # Check gap to next segment
            if i < len(segments) - 1:
                gap = segments[i+1]["start"] - segment["end"]
                # If silence > 1.0s, new paragraph. Else, just space.
                if gap > 1.0:
                    output_str += "\n\n"
                else:
                    output_str += " "
        
        return output_str, len(all_words)

    # --- SUBTITLE FORMATTING LOGIC (SRT/VTT) ---
    final_blocks = [] 

    if preset_mode == "tiktok":
        for w in all_words:
            final_blocks.append({ "start": w["start"], "end": w["end"], "text": w["word"].strip() })
    else:
        current_block_lines = []
        current_line_words = []
        current_line_len = 0
        
        def flush_line():
            nonlocal current_line_len, current_line_words
            if current_line_words:
                s = current_line_words[0]["start"]; e = current_line_words[-1]["end"]
                txt = "".join([w["word"] for w in current_line_words]).strip()
                current_block_lines.append({"text": txt, "start": s, "end": e})
                current_line_words.clear(); current_line_len = 0
        
        def flush_block():
            if current_block_lines:
                s = current_block_lines[0]["start"]; e = current_block_lines[-1]["end"]
                txt = "\n".join([l["text"] for l in current_block_lines])
                final_blocks.append({"start": s, "end": e, "text": txt})
                current_block_lines.clear()
        
        for w_obj in all_words:
            word_len = len(w_obj["word"])
            if current_line_len + word_len > max_chars and current_line_len > 0:
                flush_line()
                if len(current_block_lines) >= max_lines: flush_block()
            current_line_words.append(w_obj); current_line_len += word_len
        
        flush_line(); flush_block()

    output_str = ""
    if format_type == "vtt": output_str += "WEBVTT\n\n"
    
    counter = 1
    for b in final_blocks:
        text = b["text"]
        if use_profanity: text = apply_profanity_filter(text)
        
        s_ts = format_timestamp(b["start"], format_type)
        e_ts = format_timestamp(b["end"], format_type)
        sep = " --> " if format_type == "srt" else " --> " 
        output_str += f"{counter}\n{s_ts}{sep}{e_ts}\n{text}\n\n"; counter += 1
            
    return output_str, len(all_words)

# --- PROCESSOR ---
def process_file(args):
    path = args.get("path")
    if not os.path.exists(path):
        send_to_electron("error", "File not found"); return

    model = load_ai_model(args.get("model", "standard"), args.get("device", "auto"))
    if not model: return

    send_to_electron("progress", "Transcribing...", 10)

    # 1. EXTRACT AUDIO SILENTLY (Prevents Flashing)
    temp_audio_path = extract_audio_silent(path)
    if not temp_audio_path:
        # Fallback: let Whisper (via our custom loader) handle original file
        temp_audio_path = path

    opts = {"word_timestamps": True, "verbose": False}
    if args.get("language") and args.get("language") != "auto":
        opts["language"] = args.get("language")
    

    try:
        # 2. TRANSCRIBE (Use temp audio path; our custom loader handles WAV vs other formats)
        result = model.transcribe(temp_audio_path, **opts)

        # Cleanup extracted temp audio (but never delete the original input)
        if temp_audio_path != path and os.path.exists(temp_audio_path):
            os.remove(temp_audio_path)

        send_to_electron("progress", "Formatting...", 90)

        # Confidence
        avg_logprob = sum([s["avg_logprob"] for s in result["segments"]]) / len(result["segments"]) if result["segments"] else -1
        confidence = round(100 * (2.718 ** avg_logprob))

        content, word_count = generate_output(
            result, 
            args.get("format", "srt"),
            args.get("preset", "standard"),
            args.get("maxChars", 42),
            args.get("maxLines", 2),
            args.get("profanity", False)
        )

        # Save Logic
        base_name = os.path.splitext(os.path.basename(path))[0]  # filename without extension
        src_ext = os.path.splitext(os.path.basename(path))[1].lstrip(".").lower()
        ext = args.get("format", "srt")
        suffix = args.get("outputName", "subs")
        safe_suffix = "".join([c for c in suffix if c.isalnum() or c in "_-"])

        # Include original extension to avoid collisions (e.g., video.mp4 vs video.wav)
        if src_ext:
            file_stem = f"{base_name}_{src_ext}"
        else:
            file_stem = base_name
        
        # Determine Folder
        out_dir = args.get("outputDir", "")
        if not out_dir or not os.path.exists(out_dir):
            out_dir = os.path.dirname(path)  # Default to source folder
            
        save_path = os.path.join(out_dir, f"{file_stem}_{safe_suffix}.{ext}")
        
        with open(save_path, "w", encoding="utf-8") as f:
            f.write(content)

        send_to_electron("success", f"Done!", {
            "path": path,
            "savePath": save_path,
            "wordCount": word_count,
            "confidence": confidence
        })

    except Exception as e:
        send_to_electron("error", str(e))

def main():
    send_to_electron("status", "Engine Ready")
    send_to_electron("info", f"System: {get_device().upper()} Acceleration Detected")

    while True:
        try:
            line = sys.stdin.readline()
            if not line: break
            data = json.loads(line)
            cmd = data.get("command")

            if cmd == "analyze":
                analyze_file(data.get("path"))
            elif cmd == "transcribe":
                process_file(data)
                
        except json.JSONDecodeError: pass
        except KeyboardInterrupt: break

if __name__ == "__main__":
    main()