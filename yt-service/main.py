from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from youtube_transcript_api import YouTubeTranscriptApi
from urllib.parse import urlparse, parse_qs
import logging
import sys
import os
from importlib.metadata import version, PackageNotFoundError

app = FastAPI()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

try:
    pkg_version = version("youtube-transcript-api")
except PackageNotFoundError:
    pkg_version = "package_not_found"

logger.info(f"YouTube Transcript API Package Version: {pkg_version}")
logger.info(f"Python Version: {sys.version}")

class TranscriptRequest(BaseModel):
    url: str

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

@app.post("/transcript")
async def get_transcript(req: TranscriptRequest):
    url = req.url
    logger.info(f"Received request for URL: {url}")
    
    video_id = extract_video_id(url)
    if not video_id:
        raise HTTPException(status_code=400, detail="Could not extract video ID from URL.")

    try:
        # Use list() to find the best available transcript (v1.2.3+ API)
        # Note: list() is an instance method in this version
        
        # Configure proxies
        proxy_url = os.getenv("PROXY_URL")
        
        # Alternative: Construct from separate vars (safer for special chars)
        if not proxy_url:
            p_host = os.getenv("PROXY_HOST")
            p_port = os.getenv("PROXY_PORT")
            p_user = os.getenv("PROXY_USER")
            p_pass = os.getenv("PROXY_PASS")
            
            if p_host and p_port and p_user and p_pass:
                from urllib.parse import quote
                # URL encode credentials to handle special characters safely
                safe_user = quote(p_user)
                safe_pass = quote(p_pass)
                proxy_url = f"http://{safe_user}:{safe_pass}@{p_host}:{p_port}"
                logger.info("Constructed Proxy URL from env vars")

        proxy_config = None
        if proxy_url:
            logger.info("Using Proxy for YouTube requests")
            from youtube_transcript_api.proxies import GenericProxyConfig
            proxy_config = GenericProxyConfig(http_url=proxy_url, https_url=proxy_url)

        # Instantiate API with proxy config
        if proxy_config:
            api = YouTubeTranscriptApi(proxy_config=proxy_config)
        else:
            api = YouTubeTranscriptApi()

        # Call list() without cookies (proxies should handle auth/rotation)
        # Cookies seem to be unsupported in this version's .list() method or require a different approach.
        # Since we have a residential proxy, we shouldn't need cookies.
        transcript_list = api.list(video_id)
        
        transcript = None
        try:
            # Try fetching manual English transcript
            transcript = transcript_list.find_manually_created_transcript(['en'])
        except:
            try:
                # Try fetching generated English transcript
                transcript = transcript_list.find_generated_transcript(['en'])
            except:
                # Fallback: try any English transcript
                try:
                    transcript = transcript_list.find_transcript(['en'])
                except:
                    pass

        if not transcript:
             raise Exception("No suitable English transcript found.")

        fetched_transcript = transcript.fetch()
        
        # Join them into a single string
        # v1.2.3 returns objects, not dicts
        full_text = " ".join([item.text for item in fetched_transcript])
        
        # Clean up whitespace
        full_text = " ".join(full_text.split())
        
        return {"transcript": full_text}

    except Exception as e:
        logger.error(f"Error processing {video_id}: {str(e)}")
        
        # Check if proxy was configured (either via URL or parts)
        is_proxy = os.getenv("PROXY_URL") or (
            os.getenv("PROXY_HOST") and os.getenv("PROXY_PORT")
        )
        proxy_status = "ON" if is_proxy else "OFF"
        
        msg = f"[v={pkg_version} proxy={proxy_status}] {str(e)}"
        raise HTTPException(status_code=400, detail=msg)
