"""
Test script to verify Fireworks AI reasoning trace extraction.

Run this to test if reasoning traces are being extracted correctly.
"""
import asyncio
import os
from dotenv import load_dotenv
from services.fireworks_client import get_fireworks_client

load_dotenv()

async def test_fireworks_reasoning():
    """Test Fireworks AI reasoning trace extraction."""
    print("🧪 Testing Fireworks AI reasoning trace extraction...\n")
    
    # Check API key
    api_key = os.getenv("FIREWORKS_API_KEY")
    if not api_key:
        print("❌ FIREWORKS_API_KEY not found in .env file")
        return
    
    print("✓ API key found\n")
    
    # Get client
    client = get_fireworks_client()
    
    # Test with a simple prompt that should generate reasoning
    test_prompt = "Solve this step by step: What is 15 * 23?"
    model = "accounts/fireworks/models/qwen3-235b-a22b-thinking-2507"
    
    print(f"📝 Test prompt: {test_prompt}")
    print(f"🤖 Model: {model}\n")
    print("⏳ Calling Fireworks AI...\n")
    
    try:
        response_text, reasoning_trace, error = await client.call_with_retry(
            prompt=test_prompt,
            model=model,
            max_retries=1,
            timeout=60.0
        )
        
        if error:
            print(f"❌ Error: {error}\n")
            return
        
        print("=" * 80)
        print("📤 RESPONSE TEXT:")
        print("=" * 80)
        print(response_text)
        print()
        
        print("=" * 80)
        print("🧠 REASONING TRACE:")
        print("=" * 80)
        if reasoning_trace:
            print(reasoning_trace)
            print(f"\n✓ Reasoning trace extracted successfully! ({len(reasoning_trace)} characters)")
        else:
            print("⚠️  No reasoning trace found in response")
            print("   This could mean:")
            print("   - The model didn't generate reasoning for this prompt")
            print("   - The API response format is different than expected")
            print("   - Check the raw API response structure")
        print()
        
        # Show what fields were checked
        print("=" * 80)
        print("🔍 DEBUG INFO:")
        print("=" * 80)
        print("The code checks for reasoning in (priority order):")
        print("  1. message.reasoning_content (Fireworks-specific)")
        print("  2. message.reasoning_details (array format, like OpenRouter)")
        print("  3. message.reasoning or message.thinking (fallback)")
        print("  4. <think>...</think> tags in content field")
        print()
        
    except Exception as e:
        print(f"❌ Exception occurred: {str(e)}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(test_fireworks_reasoning())
