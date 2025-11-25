from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from urllib.parse import urlparse, parse_qs
import logging
import sys
import os
import yt_dlp
import json

app = FastAPI()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

try:
    import importlib.metadata
    pkg_version = importlib.metadata.version("yt-dlp")
except Exception:
    pkg_version = "unknown"

logger.info(f"yt-dlp Version: {pkg_version}")
logger.info(f"Python Version: {sys.version}")

import random

# Proxy Configuration
PROXY_HOST = "gate.decodo.com"
PROXY_USER = "sp1o3ikf9t"
PROXY_PASS = "2ZV6s5HgNvxp~r5nkj"
PROXY_PORT_START = 10001
PROXY_PORT_END = 10010

def get_random_proxy():
    """
    Returns a random proxy URL from the configured range.
    Format: http://user:pass@host:port
    """
    port = random.randint(PROXY_PORT_START, PROXY_PORT_END)
    proxy_url = f"http://{PROXY_USER}:{PROXY_PASS}@{PROXY_HOST}:{port}"
    return proxy_url, port

class TranscriptRequest(BaseModel):
    youtube_url: str
    language_code: str | None = None
    is_generated: bool | None = None

# Simple in-memory cache for demonstration purposes
metadata_cache = {}
transcript_cache = {}

def get_from_cache(cache_dict, key):
    return cache_dict.get(key)

def set_to_cache(cache_dict, key, value):
    cache_dict[key] = value

def extract_video_id(url: str):
    """
    Extracts the video ID from a YouTube URL.
    """
    parsed = urlparse(url)
    if parsed.hostname == 'youtu.be':
        return parsed.path[1:]
    if parsed.hostname in ('www.youtube.com', 'youtube.com'):
        if parsed.path == '/watch':
            p = parse_qs(parsed.query)
            return p.get('v', [None])[0]
        if parsed.path.startswith('/embed/'):
            return parsed.path.split('/')[2]
        if parsed.path.startswith('/v/'):
            return parsed.path.split('/')[2]
    if 'http' in url:
        return None
    return url

@app.post("/metadata")
async def get_metadata(req: TranscriptRequest):
    video_id = extract_video_id(req.youtube_url)
    if not video_id:
        raise HTTPException(status_code=400, detail="Invalid YouTube URL")
    
    # Check cache first
    cached_data = get_from_cache(metadata_cache, video_id)
    if cached_data:
        return cached_data

    try:
        # Check for cookies file (try multiple locations)
        cookies_file = None
        possible_paths = [
            "/app/cookies.txt",
            "cookies.txt",
            os.path.join(os.path.dirname(__file__), "cookies.txt")
        ]
        
        logger.info(f"Current working directory: {os.getcwd()}")
        logger.info(f"__file__ location: {os.path.dirname(__file__)}")
        
        for path in possible_paths:
            logger.info(f"Checking for cookies at: {path}")
            if os.path.exists(path):
                cookies_file = path
                logger.info(f"✅ Found cookies at: {path}")
                # Check if file is readable
                try:
                    with open(path, 'r') as f:
                        first_line = f.readline()
                        logger.info(f"First line of cookies file: {first_line[:50]}")
                except Exception as e:
                    logger.error(f"Error reading cookies file: {e}")
                break
            else:
                logger.info(f"❌ Not found at: {path}")
        
        if not cookies_file:
            logger.error("⚠️ NO COOKIES FILE FOUND IN ANY LOCATION")
            logger.info(f"Files in /app: {os.listdir('/app') if os.path.exists('/app') else 'N/A'}")
            logger.info(f"Files in current dir: {os.listdir('.')}")
        
        ydl_opts = {
            'skip_download': True,
            'quiet': False,
            'no_warnings': False,
            'verbose': True,
            'user_agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'format': 'bestaudio/best',
            'ignore_no_formats_error': True,
        }
        
        # Add Proxy
        proxy_url, proxy_port = get_random_proxy()
        ydl_opts['proxy'] = proxy_url
        logger.info(f"🛡️ Using Proxy: {PROXY_HOST}:{proxy_port}")
        
        # When using rotating proxies, DO NOT use cookies as it triggers security flags
        if cookies_file:
            logger.info(f"🍪 Cookies found at {cookies_file} but SKIPPING because proxy is enabled")
        else:
            logger.warning("⚠️ Proceeding WITHOUT cookies (Proxy Enabled)")
        
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(req.youtube_url, download=False)
            
            transcripts = []
            
            # Get manual subtitles
            if 'subtitles' in info and info['subtitles']:
                for lang_code, subs in info['subtitles'].items():
                    if subs:  # Check if list is not empty
                        lang_name = subs[0].get('name', lang_code) if isinstance(subs, list) else lang_code
                        transcripts.append({
                            "language": lang_name,
                            "language_code": lang_code,
                            "is_generated": False,
                            "is_translatable": True,
                        })
            
            # Get automatic captions
            if 'automatic_captions' in info and info['automatic_captions']:
                for lang_code, subs in info['automatic_captions'].items():
                    if subs:  # Check if list is not empty
                        lang_name = subs[0].get('name', lang_code) if isinstance(subs, list) else lang_code
                        transcripts.append({
                            "language": lang_name,
                            "language_code": lang_code,
                            "is_generated": True,
                            "is_translatable": True,
                        })
            
            if not transcripts:
                raise HTTPException(
                    status_code=404,
                    detail="No captions available for this video."
                )
                
        response_data = {"transcripts": transcripts}
        set_to_cache(metadata_cache, video_id, response_data)
        return response_data

    except yt_dlp.utils.DownloadError as e:
        logger.error(f"yt-dlp error: {e}")
        cookie_status = f"[Cookies: {'Found at ' + cookies_file if cookies_file else 'NOT FOUND'}]"
        raise HTTPException(status_code=404, detail=f"Video not found or unavailable: {str(e)} {cookie_status}")
    except Exception as e:
        logger.error(f"Error fetching metadata for {video_id}: {str(e)}")
        cookie_status = f"[Cookies: {'Found at ' + cookies_file if cookies_file else 'NOT FOUND'}]"
        raise HTTPException(status_code=500, detail=f"[v={pkg_version}] {str(e)} {cookie_status}")

@app.post("/transcript")
async def get_transcript(req: TranscriptRequest):
    video_id = extract_video_id(req.youtube_url)
    if not video_id:
        raise HTTPException(status_code=400, detail="Invalid YouTube URL")

    # Check cache
    cache_key = f"{video_id}_{req.language_code}"
    cached_data = get_from_cache(transcript_cache, cache_key)
    if cached_data:
        return cached_data

    try:
        # Check for cookies file (try multiple locations)
        cookies_file = None
        possible_paths = [
            "cookies.txt",
            "/app/cookies.txt",
            os.path.join(os.path.dirname(__file__), "cookies.txt")
        ]
        
        for path in possible_paths:
            if os.path.exists(path):
                cookies_file = path
                break
        
        # Determine which language to fetch
        target_lang = req.language_code if req.language_code else 'en'
        
        ydl_opts = {
            'skip_download': True,
            'writesubtitles': True,
            'writeautomaticsub': True,
            'subtitleslangs': [target_lang],
            'subtitlesformat': 'json3',
            'quiet': True,
            'no_warnings': True,
            'user_agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'format': 'bestaudio/best',
            'ignore_no_formats_error': True,
        }
        
        # Add Proxy
        proxy_url, proxy_port = get_random_proxy()
        ydl_opts['proxy'] = proxy_url
        logger.info(f"🛡️ Using Proxy: {PROXY_HOST}:{proxy_port}")
        
        # When using rotating proxies, DO NOT use cookies as it triggers security flags
        # (Changing IP + Same Session = Suspicious)
        if cookies_file:
            logger.info(f"🍪 Cookies found at {cookies_file} but SKIPPING because proxy is enabled")
        
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(req.youtube_url, download=False)
            
            # Try to get the requested subtitle
            subtitle_data = None
            
            # If user specified a language and type
            if req.language_code:
                if req.is_generated:
                    if 'automatic_captions' in info and req.language_code in info['automatic_captions']:
                        subtitle_data = info['automatic_captions'][req.language_code]
                elif req.is_generated is False:
                     if 'subtitles' in info and req.language_code in info['subtitles']:
                        subtitle_data = info['subtitles'][req.language_code]
                else: # is_generated is None
                    if 'subtitles' in info and req.language_code in info['subtitles']:
                        subtitle_data = info['subtitles'][req.language_code]
                    elif 'automatic_captions' in info and req.language_code in info['automatic_captions']:
                        subtitle_data = info['automatic_captions'][req.language_code]
            
            # Fallback logic if specific track not found
            if not subtitle_data:
                if 'automatic_captions' in info and 'en' in info['automatic_captions']:
                    subtitle_data = info['automatic_captions']['en']
                elif 'subtitles' in info and info['subtitles']:
                    # Get first available manual subtitle
                    first_lang = next(iter(info['subtitles']))
                    subtitle_data = info['subtitles'][first_lang]
                elif 'automatic_captions' in info and info['automatic_captions']:
                    # Get first available automatic caption
                    first_lang = next(iter(info['automatic_captions']))
                    subtitle_data = info['automatic_captions'][first_lang]
            
            if not subtitle_data:
                raise HTTPException(
                    status_code=404,
                    detail=f"No caption track found for language: {req.language_code or 'en'}"
                )
            
            # Download the subtitle content
            # subtitle_data is a list of formats, get the json3 one
            json3_url = None
            for fmt in subtitle_data:
                if fmt.get('ext') == 'json3':
                    json3_url = fmt.get('url')
                    break
            
            if not json3_url:
                # Fallback to first available format
                json3_url = subtitle_data[0].get('url')
            
            if not json3_url:
                raise HTTPException(status_code=500, detail="Could not find subtitle URL")
            
            # Fetch the subtitle content
            import urllib.request
            with urllib.request.urlopen(json3_url) as response:
                subtitle_content = response.read().decode('utf-8')
            
            # Parse JSON3 format
            subtitle_json = json.loads(subtitle_content)
            
            # Extract text from JSON3 format
            texts = []
            if 'events' in subtitle_json:
                for event in subtitle_json['events']:
                    if 'segs' in event:
                        for seg in event['segs']:
                            if 'utf8' in seg:
                                texts.append(seg['utf8'])
            
            full_text = " ".join(texts)
            full_text = " ".join(full_text.split())  # Clean whitespace
            
            if not full_text:
                raise HTTPException(status_code=404, detail="Caption track is empty.")
            
            response_data = {"transcript": full_text}
            set_to_cache(transcript_cache, cache_key, response_data)
            return response_data

    except yt_dlp.utils.DownloadError as e:
        logger.error(f"yt-dlp error: {e}")
        cookie_status = f"[Cookies: {'Found at ' + cookies_file if cookies_file else 'NOT FOUND'}]"
        raise HTTPException(status_code=404, detail=f"Video not found or unavailable: {str(e)} {cookie_status}")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error processing {video_id}: {str(e)}")
        cookie_status = f"[Cookies: {'Found at ' + cookies_file if cookies_file else 'NOT FOUND'}]"
        raise HTTPException(status_code=500, detail=f"[v={pkg_version}] {str(e)} {cookie_status}")
