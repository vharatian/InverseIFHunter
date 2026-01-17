# Debug Workflow for Missing Criteria Detection

## Expected Workflow

1. **First Load (with C1, C2, C3, C4)**:
   - `populatePreviewTabs()` is called
   - `state.initialCriteria` = [C1, C2, C3, C4] ✅ SET ONCE
   - `state.criteria` = [C1, C2, C3, C4]

2. **User Removes C3 in Colab**:
   - User edits `response_reference` in Colab, removes C3
   - User clicks "Save to Colab & Re-judge" or "Judge Only"

3. **Pre-Judge Check** (in `judgeReferenceResponse`):
   - Reads current `response_reference` from preview: [C1, C2, C4]
   - Compares with `state.initialCriteria`: [C1, C2, C3, C4]
   - Detects C3 is missing
   - **Should block judging** and show warning

4. **OR Post-Judge Check** (if pre-check is bypassed):
   - Judge returns: {C1: "PASS", C2: "PASS", C4: "PASS"}
   - Compares `state.initialCriteria` [C1, C2, C3, C4] with current [C1, C2, C4]
   - Detects C3 is missing
   - Adds C3: "MISSING" to criteria object
   - **Should show C3 as MISSING** in display

## What to Check in Browser Console

When you judge, check the console for these logs:

1. **When notebook loads**:
   ```
   ✅ INITIAL CRITERIA SET (first time): ['C1', 'C2', 'C3', 'C4']
   ```

2. **When you click "Judge Only"**:
   ```
   🔍 PRE-JUDGE CHECK:
      Initial criteria IDs: ['C1', 'C2', 'C3', 'C4']
      Current criteria IDs: ['C1', 'C2', 'C4']
      Missing criteria IDs: ['C3']
   ```

3. **After judge returns**:
   ```
   🔍 POST-JUDGE MISSING CHECK:
      Initial criteria IDs: ['C1', 'C2', 'C3', 'C4']
      Current criteria IDs: ['C1', 'C2', 'C4']
      Missing criteria IDs: ['C3']
   ⚠️ MISSING CRITERIA DETECTED: ['C3']
   Final judge result criteria (including missing): ['C1', 'C2', 'C3', 'C4']
   ```

## Common Issues

1. **If `state.initialCriteria` is null or empty**:
   - The notebook was loaded AFTER C3 was removed
   - Solution: Reload the notebook from the ORIGINAL Colab URL (with C3 still present)

2. **If missing criteria IDs is empty**:
   - `state.initialCriteria` doesn't have C3
   - Check: `console.log(state.initialCriteria)` in browser console

3. **If C3 is detected but not shown**:
   - Check if `criteria['C3']` exists in the criteria object
   - Check `formatJudgeCriteriaDisplay` function

## How to Test

1. Load notebook with C1, C2, C3, C4
2. Check console: Should see "✅ INITIAL CRITERIA SET"
3. Remove C3 in Colab
4. Click "Judge Only"
5. Check console: Should see "🔍 PRE-JUDGE CHECK" with C3 in missing
6. If judging proceeds, check "🔍 POST-JUDGE MISSING CHECK"
7. C3 should appear in results as ⚠️ MISSING

