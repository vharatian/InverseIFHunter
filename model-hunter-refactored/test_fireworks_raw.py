"""
Test script to see RAW Fireworks API response structure.
Uses only built-in Python libraries.
"""
import os
import json
import urllib.request
import urllib.error
import ssl
import re

# Use shared test utilities
from test_utils import load_env

def test_fireworks_raw():
    """Call Fireworks API and print the RAW response."""
    print("=" * 80)
    print("🔍 FIREWORKS RAW RESPONSE TEST (v2 - with split analysis)")
    print("=" * 80)
    
    load_env()
    
    api_key = os.getenv("FIREWORKS_API_KEY")
    if not api_key:
        print("❌ FIREWORKS_API_KEY not found in .env file")
        return
    
    print("✓ API key found\n")
    
    # Simple prompt that should trigger reasoning
    test_prompt = "What is 15 * 23? Think step by step before giving your answer."
    model = "accounts/fireworks/models/qwen3-235b-a22b-thinking-2507"
    
    print(f"📝 Prompt: {test_prompt}")
    print(f"🤖 Model: {model}")
    print()
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": test_prompt}],
        "max_tokens": 4096,
        "temperature": 0.7,
        "stream": False
    }
    
    print("⏳ Calling Fireworks API (non-streaming)...\n")
    
    try:
        # Create request
        url = "https://api.fireworks.ai/inference/v1/chat/completions"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode('utf-8'),
            headers=headers,
            method='POST'
        )
        
        # Create SSL context
        context = ssl.create_default_context()
        
        # Make request
        with urllib.request.urlopen(req, timeout=120, context=context) as response:
            status_code = response.status
            response_text = response.read().decode('utf-8')
            
            print(f"📊 HTTP Status: {status_code}")
            print()
            
            data = json.loads(response_text)
            
            # Get content
            content = ""
            if "choices" in data and data["choices"]:
                message = data["choices"][0].get("message", {})
                content = message.get("content", "") or ""
            
            # ============================================
            # TAG ANALYSIS
            # ============================================
            print("=" * 80)
            print("🏷️  TAG ANALYSIS:")
            print("=" * 80)
            
            has_open_think = "<think>" in content
            has_close_think = "</think>" in content
            
            print(f"\n   Has <think> opening tag:  {'✅ YES' if has_open_think else '❌ NO'}")
            print(f"   Has </think> closing tag: {'✅ YES' if has_close_think else '❌ NO'}")
            
            # Count occurrences
            open_count = content.count("<think>")
            close_count = content.count("</think>")
            print(f"\n   <think> count:  {open_count}")
            print(f"   </think> count: {close_count}")
            
            # ============================================
            # EXTRACTION TEST
            # ============================================
            print("\n" + "=" * 80)
            print("🔧 EXTRACTION TEST:")
            print("=" * 80)
            
            reasoning = ""
            answer = ""
            
            # Method 1: Standard <think>...</think> regex
            print("\n📌 Method 1: Regex <think>(.*?)</think>")
            think_pattern = r'<think>(.*?)</think>'
            think_matches = re.findall(think_pattern, content, re.DOTALL)
            if think_matches:
                print(f"   ✅ Found {len(think_matches)} match(es)")
                reasoning = "\n".join(think_matches)
                answer = re.sub(think_pattern, '', content, flags=re.DOTALL).strip()
            else:
                print("   ❌ No matches")
            
            # Method 2: Split on </think> (handles missing opening tag)
            print("\n📌 Method 2: Split on </think>")
            if "</think>" in content:
                parts = content.split("</think>", 1)
                reasoning_m2 = parts[0].strip()
                answer_m2 = parts[1].strip() if len(parts) > 1 else ""
                print(f"   ✅ Split successful!")
                print(f"   - Reasoning part: {len(reasoning_m2)} chars")
                print(f"   - Answer part: {len(answer_m2)} chars")
                
                # Use method 2 results if method 1 failed
                if not reasoning:
                    reasoning = reasoning_m2
                    answer = answer_m2
            else:
                print("   ❌ No </think> tag found")
            
            # Method 3: Check for other possible patterns
            print("\n📌 Method 3: Other patterns check")
            other_patterns = [
                (r'<reasoning>(.*?)</reasoning>', '<reasoning>...</reasoning>'),
                (r'<thought>(.*?)</thought>', '<thought>...</thought>'),
                (r'\*\*Reasoning:\*\*(.*?)\*\*Answer:\*\*', '**Reasoning:**...**Answer:**'),
            ]
            for pattern, name in other_patterns:
                if re.search(pattern, content, re.DOTALL | re.IGNORECASE):
                    print(f"   ✅ Found: {name}")
                else:
                    print(f"   ❌ Not found: {name}")
            
            # ============================================
            # FINAL EXTRACTION RESULTS
            # ============================================
            print("\n" + "=" * 80)
            print("📋 FINAL EXTRACTION RESULTS:")
            print("=" * 80)
            
            if reasoning and answer:
                print("\n✅ Successfully separated reasoning and answer!\n")
                
                print("-" * 40)
                print("🧠 REASONING (first 500 chars):")
                print("-" * 40)
                print(reasoning[:500])
                if len(reasoning) > 500:
                    print(f"... [{len(reasoning) - 500} more chars]")
                
                print("\n" + "-" * 40)
                print("💬 ANSWER (first 500 chars):")
                print("-" * 40)
                print(answer[:500])
                if len(answer) > 500:
                    print(f"... [{len(answer) - 500} more chars]")
                
                print("\n" + "-" * 40)
                print("📊 STATS:")
                print("-" * 40)
                print(f"   Total content:  {len(content)} chars")
                print(f"   Reasoning:      {len(reasoning)} chars ({len(reasoning)*100//len(content)}%)")
                print(f"   Answer:         {len(answer)} chars ({len(answer)*100//len(content)}%)")
            else:
                print("\n⚠️  Could not separate reasoning and answer")
                print("\n📄 FULL CONTENT (first 1000 chars):")
                print("-" * 40)
                print(content[:1000])
            
            # ============================================
            # RAW CONTENT INSPECTION (for verification)
            # ============================================
            print("\n" + "=" * 80)
            print("🔍 RAW CONTENT - FIRST 200 CHARS:")
            print("=" * 80)
            print(repr(content[:200]))
            
            print("\n" + "=" * 80)
            print("🔍 RAW CONTENT - AROUND </think> TAG:")
            print("=" * 80)
            if "</think>" in content:
                idx = content.find("</think>")
                start = max(0, idx - 100)
                end = min(len(content), idx + 150)
                print(f"... {repr(content[start:end])} ...")
            else:
                print("No </think> tag found")
    
    except urllib.error.HTTPError as e:
        print(f"❌ HTTP Error {e.code}: {e.reason}")
        try:
            error_body = e.read().decode('utf-8')
            print(f"   Response: {error_body}")
        except:
            pass
    except Exception as e:
        print(f"❌ Exception: {str(e)}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    test_fireworks_raw()
