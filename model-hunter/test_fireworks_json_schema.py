"""
Test script to see if Fireworks JSON schema gives us:
- Reasoning in </think> tags
- Concise answer in structured JSON
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
    
    with urllib.request.urlopen(req, timeout=180, context=context) as response:
        return response.status, json.loads(response.read().decode('utf-8'))

def test_json_schema():
    """Test JSON schema response format."""
    print("=" * 80)
    print("🔬 FIREWORKS JSON SCHEMA TEST")
    print("   Testing structured output with thinking model")
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
    
    model = "accounts/fireworks/models/qwen3-235b-a22b-thinking-2507"
    
    # Test prompts - different types
    test_cases = [
        {
            "name": "Math question",
            "prompt": "What is 15 * 23?",
        },
        {
            "name": "Yes/No question",
            "prompt": "Is Python a compiled language?",
        },
    ]
    
    chat_url = "https://api.fireworks.ai/inference/v1/chat/completions"
    
    for i, test in enumerate(test_cases):
        print(f"\n{'=' * 80}")
        print(f"📝 TEST {i+1}: {test['name']}")
        print(f"   Prompt: {test['prompt']}")
        print("=" * 80)
        
        # JSON Schema requesting concise answer
        payload = {
            "model": model,
            "messages": [
                {
                    "role": "user", 
                    "content": test['prompt']
                }
            ],
            "max_tokens": 4096,
            "temperature": 0.7,
            "response_format": {
                "type": "json_object",
                "schema": {
                    "type": "object",
                    "properties": {
                        "answer": {
                            "type": "string",
                            "description": "The final answer only. Be concise - just the answer, no explanation."
                        }
                    },
                    "required": ["answer"]
                }
            }
        }
        
        print("\n📤 Request payload (with JSON schema):")
        print(json.dumps(payload, indent=2))
        
        try:
            print("\n⏳ Calling Fireworks API with JSON schema...")
            status, data = make_request(chat_url, payload, headers)
            print(f"✅ Status: {status}")
            
            print("\n📥 Full response:")
            print(json.dumps(data, indent=2))
            
            if "choices" in data and data["choices"]:
                content = data["choices"][0].get("message", {}).get("content", "")
                
                print("\n" + "-" * 40)
                print("📊 ANALYSIS:")
                print("-" * 40)
                
                print(f"\n   Content length: {len(content)} chars")
                print(f"   Has </think>: {'✅ YES' if '</think>' in content else '❌ NO'}")
                
                # Try to parse as JSON
                print("\n   Attempting to parse as JSON...")
                
                # Check if there's </think> and JSON after
                if '</think>' in content:
                    parts = content.split('</think>', 1)
                    reasoning = parts[0].strip()
                    json_part = parts[1].strip()
                    
                    print(f"   Reasoning length: {len(reasoning)} chars")
                    print(f"   JSON part: {json_part[:200]}...")
                    
                    try:
                        parsed = json.loads(json_part)
                        print(f"\n   ✅ JSON parsed successfully!")
                        print(f"   📦 Parsed answer: {parsed}")
                        
                        if "answer" in parsed:
                            print(f"\n   🎯 CONCISE ANSWER: {parsed['answer']}")
                    except json.JSONDecodeError as e:
                        print(f"   ❌ JSON parse failed: {e}")
                else:
                    # Try parsing entire content as JSON
                    try:
                        parsed = json.loads(content)
                        print(f"   ✅ Entire content is valid JSON!")
                        print(f"   📦 Parsed: {parsed}")
                    except json.JSONDecodeError:
                        print(f"   ❌ Content is not valid JSON")
                        print(f"   Raw content preview: {content[:300]}...")
        
        except urllib.error.HTTPError as e:
            print(f"❌ HTTP Error {e.code}: {e.reason}")
            try:
                error_body = e.read().decode('utf-8')
                print(f"   Response: {error_body[:500]}")
            except:
                pass
        except Exception as e:
            print(f"❌ Error: {e}")
            import traceback
            traceback.print_exc()
    
    # ========================================
    # Also test without JSON schema for comparison
    # ========================================
    print("\n" + "=" * 80)
    print("📝 COMPARISON: Same prompt WITHOUT JSON schema")
    print("=" * 80)
    
    payload_no_schema = {
        "model": model,
        "messages": [{"role": "user", "content": "What is 15 * 23?"}],
        "max_tokens": 2048,
        "temperature": 0.7,
    }
    
    try:
        print("\n⏳ Calling without JSON schema...")
        status, data = make_request(chat_url, payload_no_schema, headers)
        content = data["choices"][0]["message"]["content"]
        
        if '</think>' in content:
            parts = content.split('</think>', 1)
            reasoning = parts[0].strip()
            answer = parts[1].strip()
            print(f"\n   Reasoning: {len(reasoning)} chars")
            print(f"   Answer: {len(answer)} chars")
            print(f"   Answer preview: {answer[:200]}...")
        else:
            print(f"   No </think> tag, content: {content[:300]}...")
            
    except Exception as e:
        print(f"❌ Error: {e}")
    
    print("\n" + "=" * 80)
    print("🎯 SUMMARY")
    print("=" * 80)
    print("""
If JSON schema works:
  - We get reasoning in </think> tags
  - We get concise answer in JSON format
  - Best of both worlds!

If it doesn't work:
  - We fall back to prompt engineering
  - Or use two-call approach
""")

if __name__ == "__main__":
    test_json_schema()
