"""
Test script to compare Chat Completions vs Completions API for Fireworks.
See if Completions API returns reasoning differently.
"""
import os
import json
import urllib.request
import urllib.error
import ssl

# Use shared test utilities
from test_utils import load_env

def make_request(url, payload, headers):
    """Make HTTP request and return response."""
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers=headers,
        method='POST'
    )
    context = ssl.create_default_context()
    
    with urllib.request.urlopen(req, timeout=120, context=context) as response:
        return response.status, json.loads(response.read().decode('utf-8'))

def test_both_apis():
    """Test both Chat Completions and Completions API."""
    print("=" * 80)
    print("🔬 FIREWORKS API COMPARISON TEST")
    print("   Chat Completions vs Completions")
    print("=" * 80)
    
    load_env()
    
    api_key = os.getenv("FIREWORKS_API_KEY")
    if not api_key:
        print("❌ FIREWORKS_API_KEY not found in .env file")
        return
    
    print("✓ API key found\n")
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    
    test_prompt = "What is 15 * 23? Think step by step."
    model = "accounts/fireworks/models/qwen3-235b-a22b-thinking-2507"
    
    print(f"📝 Prompt: {test_prompt}")
    print(f"🤖 Model: {model}")
    
    # ========================================
    # TEST 1: Chat Completions API
    # ========================================
    print("\n" + "=" * 80)
    print("📡 TEST 1: CHAT COMPLETIONS API")
    print("   Endpoint: /v1/chat/completions")
    print("=" * 80)
    
    chat_url = "https://api.fireworks.ai/inference/v1/chat/completions"
    chat_payload = {
        "model": model,
        "messages": [{"role": "user", "content": test_prompt}],
        "max_tokens": 2048,
        "temperature": 0.7,
        "stream": False
    }
    
    print("\n📤 Request payload:")
    print(json.dumps(chat_payload, indent=2))
    
    try:
        print("\n⏳ Calling Chat Completions API...")
        status, chat_data = make_request(chat_url, chat_payload, headers)
        print(f"✅ Status: {status}")
        
        print("\n📥 Response structure:")
        print(f"   Top-level keys: {list(chat_data.keys())}")
        
        if "choices" in chat_data and chat_data["choices"]:
            choice = chat_data["choices"][0]
            print(f"   Choice keys: {list(choice.keys())}")
            
            if "message" in choice:
                msg = choice["message"]
                print(f"   Message keys: {list(msg.keys())}")
                content = msg.get("content", "")
                
                print(f"\n   Content length: {len(content)} chars")
                print(f"   Has </think>: {'✅ YES' if '</think>' in content else '❌ NO'}")
                print(f"   Has <think>: {'✅ YES' if '<think>' in content else '❌ NO'}")
                
                # Check for any reasoning-related fields
                for key in msg.keys():
                    if key not in ['role', 'content']:
                        print(f"   ⭐ Extra field: {key} = {msg[key][:100] if isinstance(msg[key], str) else msg[key]}")
        
        chat_content = chat_data.get("choices", [{}])[0].get("message", {}).get("content", "")
        
    except urllib.error.HTTPError as e:
        print(f"❌ HTTP Error {e.code}: {e.reason}")
        chat_content = None
    except Exception as e:
        print(f"❌ Error: {e}")
        chat_content = None
    
    # ========================================
    # TEST 2: Completions API
    # ========================================
    print("\n" + "=" * 80)
    print("📡 TEST 2: COMPLETIONS API (Legacy)")
    print("   Endpoint: /v1/completions")
    print("=" * 80)
    
    completions_url = "https://api.fireworks.ai/inference/v1/completions"
    completions_payload = {
        "model": model,
        "prompt": test_prompt,  # Single string, not messages
        "max_tokens": 2048,
        "temperature": 0.7,
        "stream": False
    }
    
    print("\n📤 Request payload:")
    print(json.dumps(completions_payload, indent=2))
    
    try:
        print("\n⏳ Calling Completions API...")
        status, comp_data = make_request(completions_url, completions_payload, headers)
        print(f"✅ Status: {status}")
        
        print("\n📥 Response structure:")
        print(f"   Top-level keys: {list(comp_data.keys())}")
        
        if "choices" in comp_data and comp_data["choices"]:
            choice = comp_data["choices"][0]
            print(f"   Choice keys: {list(choice.keys())}")
            
            # Completions API uses 'text' instead of 'message.content'
            if "text" in choice:
                text = choice["text"]
                print(f"\n   Text length: {len(text)} chars")
                print(f"   Has </think>: {'✅ YES' if '</think>' in text else '❌ NO'}")
                print(f"   Has <think>: {'✅ YES' if '<think>' in text else '❌ NO'}")
            
            # Check for any other fields (reasoning, thinking, etc.)
            for key in choice.keys():
                if key not in ['text', 'index', 'finish_reason', 'logprobs']:
                    print(f"   ⭐ Extra field: {key} = {choice[key][:100] if isinstance(choice[key], str) else choice[key]}")
        
        comp_text = comp_data.get("choices", [{}])[0].get("text", "")
        
    except urllib.error.HTTPError as e:
        print(f"❌ HTTP Error {e.code}: {e.reason}")
        try:
            error_body = e.read().decode('utf-8')
            print(f"   Response: {error_body[:500]}")
        except:
            pass
        comp_text = None
    except Exception as e:
        print(f"❌ Error: {e}")
        comp_text = None
    
    # ========================================
    # COMPARISON
    # ========================================
    print("\n" + "=" * 80)
    print("📊 COMPARISON SUMMARY")
    print("=" * 80)
    
    print("\n| Aspect | Chat Completions | Completions |")
    print("|--------|------------------|-------------|")
    
    if chat_content:
        chat_has_think = '</think>' in chat_content
        print(f"| Has </think> tag | {'✅ Yes' if chat_has_think else '❌ No'} | ", end="")
    else:
        print("| Has </think> tag | ❌ Error | ", end="")
    
    if comp_text:
        comp_has_think = '</think>' in comp_text
        print(f"{'✅ Yes' if comp_has_think else '❌ No'} |")
    else:
        print("❌ Error |")
    
    if chat_content and comp_text:
        print(f"| Content length | {len(chat_content)} chars | {len(comp_text)} chars |")
        print(f"| Response field | message.content | text |")
        
        # Check if output is similar
        chat_answer = chat_content.split('</think>')[-1].strip()[:100] if '</think>' in chat_content else chat_content[:100]
        comp_answer = comp_text.split('</think>')[-1].strip()[:100] if '</think>' in comp_text else comp_text[:100]
        
        print(f"\n📝 Chat API answer preview: {chat_answer}...")
        print(f"📝 Completions API answer preview: {comp_answer}...")
    
    print("\n" + "=" * 80)
    print("🎯 CONCLUSION")
    print("=" * 80)
    
    if comp_text is None:
        print("\n⚠️  Completions API might not support this model or returned an error.")
        print("   Chat Completions API is the way to go.")
    elif chat_content and comp_text:
        both_have_think = ('</think>' in chat_content) and ('</think>' in comp_text)
        if both_have_think:
            print("\n✅ Both APIs return the same </think> pattern!")
            print("   → No benefit to switching APIs")
            print("   → Just fix the parsing to split on </think>")
        else:
            print("\n🔍 Different behavior detected - worth investigating further!")

if __name__ == "__main__":
    test_both_apis()
