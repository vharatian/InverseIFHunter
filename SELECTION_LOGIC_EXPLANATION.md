# Selection Logic - Complete Explanation

## How Selection Works

### Step 1: Identifying Breaking vs Passing
- **Breaking**: `judge_score === 0` OR `score === 0` (model failed)
- **Passing**: `judge_score > 0` OR `score > 0` (model passed)

### Step 2: Valid Final Combinations (4 items selected)
Only TWO valid final states are allowed:
1. **4 breaking, 0 passing** ✅
2. **3 breaking, 1 passing** ✅

### Step 3: Validation at Each Step

#### When selecting 1st item (0 items currently selected):
- ✅ **ALLOWED**: Anything (breaking or passing)
- Reason: We can always correct course with remaining 3 selections

#### When selecting 2nd item (1 item currently selected):
- ✅ **ALLOWED**: 
  - (2 breaking, 0 passing) - Can add 2 breaking → (4 breaking, 0 passing) ✅
  - (1 breaking, 1 passing) - Can add 2 breaking → (3 breaking, 1 passing) ✅
- ❌ **BLOCKED**:
  - (1 breaking, 0 passing) - Cannot reach valid state (would need 3 more breaking but only 2 slots)
  - (0 breaking, 1 passing) - Cannot reach valid state (would need 3 breaking but only 2 slots)
  - (0 breaking, 2 passing) - Cannot reach valid state

#### When selecting 3rd item (2 items currently selected):
- ✅ **ALLOWED**:
  - (3 breaking, 0 passing) - Can add 1 breaking → (4 breaking, 0 passing) ✅
  - (2 breaking, 1 passing) - Can add 1 breaking → (3 breaking, 1 passing) ✅
- ❌ **BLOCKED**:
  - (2 breaking, 0 passing) - Cannot reach valid (would be 3 breaking, 0 passing - invalid)
  - (1 breaking, 1 passing) - Cannot reach valid (would be 2 breaking, 1 passing - invalid)
  - (1 breaking, 2 passing) - Cannot reach valid
  - (0 breaking, 2 passing) - Cannot reach valid
  - (0 breaking, 3 passing) - Cannot reach valid

#### When selecting 4th item (3 items currently selected):
- ✅ **ALLOWED**:
  - (4 breaking, 0 passing) ✅
  - (3 breaking, 1 passing) ✅
- ❌ **BLOCKED**: Everything else
  - (3 breaking, 0 passing) - Invalid (need 4 breaking OR 3 breaking + 1 passing)
  - (2 breaking, 2 passing) - Invalid
  - (1 breaking, 3 passing) - Invalid
  - (0 breaking, 4 passing) - Invalid
  - (2 breaking, 1 passing) - Invalid (need 3 breaking + 1 passing, not 2)

## Complete List of Valid Selection Paths

### Path 1: All 4 Breaking
1. Select 1st: Breaking → (1 breaking, 0 passing)
2. Select 2nd: Breaking → (2 breaking, 0 passing) ✅
3. Select 3rd: Breaking → (3 breaking, 0 passing) ✅
4. Select 4th: Breaking → (4 breaking, 0 passing) ✅

### Path 2: 3 Breaking + 1 Passing
**Option A:**
1. Select 1st: Breaking → (1 breaking, 0 passing)
2. Select 2nd: Breaking → (2 breaking, 0 passing) ✅
3. Select 3rd: Passing → (2 breaking, 1 passing) ✅
4. Select 4th: Breaking → (3 breaking, 1 passing) ✅

**Option B:**
1. Select 1st: Breaking → (1 breaking, 0 passing)
2. Select 2nd: Passing → (1 breaking, 1 passing) ✅
3. Select 3rd: Breaking → (2 breaking, 1 passing) ✅
4. Select 4th: Breaking → (3 breaking, 1 passing) ✅

**Option C:**
1. Select 1st: Passing → (0 breaking, 1 passing)
2. Select 2nd: Breaking → (1 breaking, 1 passing) ✅
3. Select 3rd: Breaking → (2 breaking, 1 passing) ✅
4. Select 4th: Breaking → (3 breaking, 1 passing) ✅

## Common Invalid Combinations (BLOCKED)

### At 2nd item:
- ❌ (1 breaking, 0 passing) - Blocked
- ❌ (0 breaking, 1 passing) - Blocked
- ❌ (0 breaking, 2 passing) - Blocked

### At 3rd item:
- ❌ (2 breaking, 0 passing) - Blocked
- ❌ (1 breaking, 1 passing) - Blocked (if reached from wrong path)
- ❌ (1 breaking, 2 passing) - Blocked
- ❌ (0 breaking, 2 passing) - Blocked
- ❌ (0 breaking, 3 passing) - Blocked

### At 4th item:
- ❌ (3 breaking, 0 passing) - Blocked (need 4 breaking)
- ❌ (2 breaking, 2 passing) - Blocked
- ❌ (1 breaking, 3 passing) - Blocked
- ❌ (0 breaking, 4 passing) - Blocked
- ❌ (2 breaking, 1 passing) - Blocked (need 3 breaking + 1 passing)

## Potential Issues

1. **Type Mismatch**: `hunt_id` might be string vs number causing lookups to fail
2. **Score Detection**: `judge_score` or `score` might be null/undefined
3. **State Not Updating**: `selectedHuntIds` might not be updating correctly
4. **Validation Too Strict**: The intermediate validation might be blocking valid paths

## Debug Checklist

When selection isn't working, check:
1. Are `judge_score` values correct? (0 for breaking, >0 for passing)
2. Are `hunt_id` values matching? (check console logs)
3. Is `selectedResults` finding the right items?
4. Are the counts (`breakingCount`, `passingCount`) correct?
5. Is the validation logic matching the current state?

