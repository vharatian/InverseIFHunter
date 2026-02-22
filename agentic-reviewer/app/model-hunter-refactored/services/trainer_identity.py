"""
Trainer Identity Service

Generates fun character names from fingerprints for trainer identification.
Uses Harry Potter and Jujutsu Kaisen characters.
"""
import hashlib
from typing import Optional
from fastapi import Request


# Character names from Harry Potter and Jujutsu Kaisen
CHARACTER_NAMES = [
    # Harry Potter characters (40)
    "Harry", "Hermione", "Ron", "Dumbledore", "Snape",
    "Hagrid", "McGonagall", "Sirius", "Lupin", "Dobby",
    "Neville", "Luna", "Ginny", "Draco", "Voldemort",
    "Bellatrix", "Moody", "Tonks", "Cedric", "Cho",
    "Fred", "George", "Molly", "Arthur", "Percy",
    "Fleur", "Viktor", "Hedwig", "Fawkes", "Buckbeak",
    "Kreacher", "Winky", "Firenze", "Trelawney", "Slughorn",
    "Lockhart", "Umbridge", "Kingsley", "Nymphadora", "Mundungus",
    
    # Jujutsu Kaisen characters (40)
    "Gojo", "Itadori", "Megumi", "Nobara", "Sukuna",
    "Nanami", "Maki", "Panda", "Toge", "Yuta",
    "Geto", "Mahito", "Jogo", "Hanami", "Dagon",
    "Todo", "Mai", "Miwa", "Mechamaru", "Noritoshi",
    "Choso", "Naoya", "Toji", "Rika", "Miguel",
    "Larue", "Yuki", "Tengen", "Kenjaku", "Uraume",
    "Junpei", "Yoshino", "Ijichi", "Shoko", "Utahime",
    "Kusakabe", "Mei", "Naobito", "Ogi", "Ranta",
    
    # Bonus mix (20)
    "Hedwig", "Crookshanks", "Scabbers", "Nagini", "Aragog",
    "Grawp", "Norbert", "Trevor", "Errol", "Pigwidgeon",
    "Mimiko", "Nanako", "Ogami", "Haruta", "Juzo",
    "Awasaka", "Jiro", "Granny", "Reggie", "Eso"
]


def get_client_fingerprint(request: Request) -> str:
    """
    Generate a fingerprint from client request headers.
    Combines IP + User-Agent + Accept-Language for uniqueness.
    """
    # Get client IP (handle proxy headers)
    client_ip = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
    if not client_ip:
        client_ip = request.headers.get("X-Real-IP", "")
    if not client_ip and request.client:
        client_ip = request.client.host
    
    # Get other identifying headers
    user_agent = request.headers.get("User-Agent", "")
    accept_lang = request.headers.get("Accept-Language", "")
    
    # Create fingerprint string
    fingerprint_str = f"{client_ip}|{user_agent}|{accept_lang}"
    
    # Hash it for privacy
    fingerprint_hash = hashlib.sha256(fingerprint_str.encode()).hexdigest()
    
    return fingerprint_hash


def fingerprint_to_character(fingerprint: str) -> str:
    """
    Convert a fingerprint hash to a consistent character name.
    Same fingerprint always returns same character.
    """
    # Use first 8 chars of hash as hex number
    hash_int = int(fingerprint[:8], 16)
    
    # Map to character index
    char_index = hash_int % len(CHARACTER_NAMES)
    
    # Add a number suffix for uniqueness (last 2 chars of hash as number 0-99)
    suffix_int = int(fingerprint[-4:], 16) % 100
    
    character = CHARACTER_NAMES[char_index]
    
    return f"{character}_{suffix_int:02d}"


def get_trainer_name(request: Request) -> str:
    """
    Get a fun trainer name from the request.
    Returns something like "Gojo_42" or "Hermione_17".
    """
    fingerprint = get_client_fingerprint(request)
    return fingerprint_to_character(fingerprint)


def get_trainer_info(request: Request) -> dict:
    """
    Get full trainer identification info.
    """
    fingerprint = get_client_fingerprint(request)
    trainer_name = fingerprint_to_character(fingerprint)
    
    # Get raw IP for logging (first part only for privacy)
    client_ip = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
    if not client_ip:
        client_ip = request.headers.get("X-Real-IP", "")
    if not client_ip and request.client:
        client_ip = request.client.host
    
    # Mask IP for privacy (show only first two octets)
    ip_parts = client_ip.split(".")
    masked_ip = f"{ip_parts[0]}.{ip_parts[1]}.*.*" if len(ip_parts) >= 2 else "unknown"
    
    return {
        "trainer_id": trainer_name,
        "fingerprint": fingerprint[:16],  # Short version for storage
        "ip_hint": masked_ip
    }
