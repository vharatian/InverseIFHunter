"""
Test the OpenRouter client fix for </think> split.
This uses the actual openrouter_client.py to verify the fix works.
"""
import asyncio
import os
import sys

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Use shared test utilities
from test_utils import load_env, setup_path

async def test_openrouter_fix():
    """Test the OpenRouter client with the </think> split fix."""
    print("=" * 80)
    print("🧪 TESTING OPENROUTER CLIENT FIX")
    print("   Verifying </think> split works correctly for Qwen model")
    print("=" * 80)
    
    load_env()
    
    # Import after loading env
    from services.openrouter_client import get_openrouter_client
    
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        print("❌ OPENROUTER_API_KEY not found in .env file")
        return
    
    print("✓ API key found\n")
    
    client = get_openrouter_client()
    model = "qwen/qwen3-235b-a22b-thinking-2507"  # OpenRouter Qwen model
    
    test_cases = [
        ("Math", "What is 15 * 23?"),
        ("Yes/No", "Is water wet? Answer yes or no."),
    ]
    
    for name, prompt in test_cases:
        print(f"\n{'=' * 80}")
        print(f"📝 TEST: {name}")
        print(f"   Prompt: {prompt}")
        print(f"   Model: {model}")
        print("=" * 80)
        
        try:
            response, reasoning, error = await client.call_with_retry(
                prompt=prompt,
                model=model,
                max_retries=1,
                timeout=120.0
            )
            
            if error:
                print(f"\n❌ Error: {error}")
                continue
            
            print(f"\n✅ SUCCESS!")
            print(f"\n{'─' * 40}")
            print(f"🧠 REASONING ({len(reasoning)} chars):")
            print(f"{'─' * 40}")
            print(reasoning[:500] + ("..." if len(reasoning) > 500 else ""))
            
            print(f"\n{'─' * 40}")
            print(f"💬 ANSWER ({len(response)} chars):")
            print(f"{'─' * 40}")
            print(response[:500] + ("..." if len(response) > 500 else ""))
            
            # Verify separation
            print(f"\n{'─' * 40}")
            print("📊 VERIFICATION:")
            print(f"{'─' * 40}")
            
            if reasoning and response:
                reasoning_has_answer_markers = any(m in reasoning for m in ['###', '$$', '\\boxed'])
                response_has_thinking = 'let me' in response.lower()[:100] or 'hmm' in response.lower()[:100]
                
                if not reasoning_has_answer_markers and not response_has_thinking:
                    print("   ✅ Clean separation - reasoning is thinking, answer is formatted")
                else:
                    if reasoning_has_answer_markers:
                        print("   ⚠️  Reasoning might contain formatted answer markers")
                    if response_has_thinking:
                        print("   ⚠️  Answer might contain thinking language")
            else:
                if not reasoning:
                    print("   ⚠️  No reasoning extracted")
                if not response:
                    print("   ⚠️  No response extracted")
        
        except Exception as e:
            print(f"\n❌ Exception: {e}")
            import traceback
            traceback.print_exc()
    
    print(f"\n{'=' * 80}")
    print("🎯 TEST COMPLETE")
    print("=" * 80)
    print("""
If tests passed:
  ✅ Reasoning and Answer are properly separated for OpenRouter Qwen
  ✅ Ready to deploy to VM

If tests failed:
  ❌ Check the error messages above
  ❌ May need further debugging
""")

if __name__ == "__main__":
    asyncio.run(test_openrouter_fix())
