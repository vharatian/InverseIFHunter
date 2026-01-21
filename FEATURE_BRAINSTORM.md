# Feature Brainstorm: Enhanced Judge Visibility & Individual Criterion Judging

## Overview
Three related features to improve trainer workflow:
1. **Show judge_criteria and judge_explanation immediately** (not just after reveal)
2. **Allow trainers to re-judge individual criteria separately** (per-criterion LLM judging)
3. **Keep unselected hunts unlocked** (allow changing selection after initial 4 are chosen)

---

## Feature 1: Show Judge Criteria & Explanation Immediately

### Current State
- `judge_criteria` and `judge_explanation` are stored in results
- They're only displayed AFTER clicking "Reveal LLM Judgments" button
- Hidden by default: `.llm-judge-section { display: none; }`

### Proposed Change
- Show judge criteria breakdown and explanation immediately when hunt completes
- Display in the progress table or result cards
- Still keep the "Reveal" button for final comparison workflow

### Implementation Details

#### Frontend Changes
- **File**: `model-hunter/static/app.js`
- **Function**: `handleHuntResult()`, `createResultCard()`
- **Changes**:
  1. Add criteria breakdown column to progress table
  2. Show criteria in expandable section of result cards (always visible)
  3. Format: Show each criterion with ✅ PASS / ❌ FAIL status
  4. Show judge explanation in collapsible section

#### Backend Changes
- **No changes needed** - data already available in `HuntResult`

### Time Estimate
- **Low complexity**: 2-3 hours
- Simple UI changes, data already available

### Risk Assessment
- **Low risk**: Display-only change, no logic changes
- **Potential issues**:
  - UI clutter if too many criteria
  - Performance if rendering many hunts at once

### Pros & Cons

#### Trainer Perspective
**Pros:**
- ✅ Immediate feedback on why model passed/failed
- ✅ Can see criteria breakdown without waiting for reveal
- ✅ Better understanding of model performance patterns
- ✅ Can make better selection decisions earlier

**Cons:**
- ⚠️ Might bias human judgment if they see LLM scores first
- ⚠️ Could be overwhelming with many criteria

#### Tool Builder Perspective
**Pros:**
- ✅ Simple implementation (data already exists)
- ✅ Improves transparency
- ✅ Low maintenance burden

**Cons:**
- ⚠️ Need to ensure UI doesn't get cluttered
- ⚠️ May need responsive design for mobile

---

## Feature 2: Individual Criterion Re-Judging

### Current State
- LLM judge evaluates all criteria in parallel during hunt
- Trainers can manually grade criteria (PASS/FAIL buttons)
- No way to re-run LLM judge on individual criteria

### Proposed Change
- Add "Re-judge Criterion" button next to each criterion
- When clicked, calls LLM judge API for that single criterion
- Updates only that criterion's status
- Recalculates overall score based on updated criteria

### Implementation Details

#### Backend Changes
- **File**: `model-hunter/main.py`
- **New Endpoint**: `POST /api/judge-criterion/{session_id}/{hunt_id}/{criterion_id}`
- **Logic**:
  1. Get hunt result from session
  2. Get criterion details from `response_reference`
  3. Call `_evaluate_single_criterion()` (already exists in `openai_client.py`)
  4. Update `judge_criteria` dict for that criterion
  5. Recalculate overall score (50% threshold)
  6. Update `is_breaking` flag
  7. Return updated result

#### Frontend Changes
- **File**: `model-hunter/static/app.js`
- **Changes**:
  1. Add "🔄 Re-judge" button next to each criterion in LLM judge section
  2. Show loading state during API call
  3. Update criterion status and overall score after response
  4. Handle errors gracefully

### Time Estimate
- **Medium complexity**: 4-6 hours
- New API endpoint + frontend integration
- Need to handle state updates carefully

### Risk Assessment
- **Medium risk**: 
  - State management complexity
  - Need to ensure score recalculation is correct
  - API rate limiting if many re-judges

### Pros & Cons

#### Trainer Perspective
**Pros:**
- ✅ Can verify LLM judge's decision on specific criteria
- ✅ Useful for debugging why a model got a certain score
- ✅ Can test if changing one criterion changes overall score
- ✅ Educational - see how individual criteria affect outcome

**Cons:**
- ⚠️ Additional API calls (costs money)
- ⚠️ Might be confusing if overused
- ⚠️ Could lead to "judge shopping" (re-judging until desired result)

#### Tool Builder Perspective
**Pros:**
- ✅ Reuses existing `_evaluate_single_criterion()` function
- ✅ Adds valuable debugging capability
- ✅ Can help identify judge inconsistencies

**Cons:**
- ⚠️ Additional API endpoint to maintain
- ⚠️ Need to handle concurrent re-judges
- ⚠️ State synchronization complexity
- ⚠️ Cost implications (more API calls)
- ⚠️ Need rate limiting to prevent abuse

### Edge Cases to Handle
1. What if criterion doesn't exist in `response_reference`?
2. What if hunt result is not found?
3. What if API call fails?
4. What if trainer re-judges while another operation is in progress?
5. Should re-judge update the original hunt result or create a new version?

---

## Feature 3: Keep Unselected Hunts Unlocked

### Current State
- Trainers select up to 4 hunts for review
- Selection is validated (must be 4 breaking OR 3 breaking + 1 passing)
- Once 4 are selected, they can proceed to review
- **Issue**: Can't change selection after initial 4 are chosen (need to deselect all first)

### Proposed Change
- Allow changing selection at any time (before revealing LLM judgments)
- Only lock selection after "Reveal LLM Judgments" is clicked
- Add "Change Selection" button that unlocks selection
- Validate selection when trying to proceed to review

### Implementation Details

#### Frontend Changes
- **File**: `model-hunter/static/app.js`
- **Changes**:
  1. Remove hard lock on selection after 4 are chosen
  2. Add "Change Selection" button in review section
  3. Only lock selection when `revealLLMJudgments()` is called
  4. Add validation check before allowing review to proceed
  5. Show warning if trying to change selection after reviews started

#### Backend Changes
- **Minimal changes** - mostly frontend state management
- May need to handle case where selection changes mid-review

### Time Estimate
- **Low complexity**: 2-3 hours
- Mostly frontend state management changes

### Risk Assessment
- **Low-Medium risk**:
  - Need to handle case where trainer changes selection after starting reviews
  - Need to prevent data loss if reviews are in progress
  - State synchronization

### Pros & Cons

#### Trainer Perspective
**Pros:**
- ✅ More flexibility in hunt selection
- ✅ Can adjust selection based on criteria breakdown (from Feature 1)
- ✅ Less frustrating workflow
- ✅ Can experiment with different combinations

**Cons:**
- ⚠️ Might accidentally change selection after starting reviews
- ⚠️ Could lead to confusion about which hunts are being reviewed

#### Tool Builder Perspective
**Pros:**
- ✅ Better UX
- ✅ Relatively simple to implement
- ✅ Reduces support requests

**Cons:**
- ⚠️ Need to handle edge cases (selection change mid-review)
- ⚠️ Need to prevent data loss
- ⚠️ May need to show warnings/confirmations

### Edge Cases to Handle
1. What if trainer changes selection after starting reviews?
2. What if trainer changes selection after completing some reviews?
3. Should we save reviews for unselected hunts?
4. What if trainer changes selection after revealing LLM judgments?

---

## Combined Implementation Strategy

### Phase 1: Quick Wins (Low Risk)
1. **Feature 1**: Show judge criteria immediately
2. **Feature 3**: Unlock selection flexibility

**Time**: 4-6 hours total
**Risk**: Low
**Impact**: High (immediate UX improvement)

### Phase 2: Advanced Feature (Medium Risk)
3. **Feature 2**: Individual criterion re-judging

**Time**: 4-6 hours
**Risk**: Medium
**Impact**: Medium (useful but not critical)

### Recommended Order
1. Start with Feature 1 & 3 (quick wins)
2. Test thoroughly
3. Then add Feature 2 if needed

---

## Technical Considerations

### API Design for Feature 2
```python
@app.post("/api/judge-criterion/{session_id}/{hunt_id}/{criterion_id}")
async def judge_single_criterion(
    session_id: str,
    hunt_id: int,
    criterion_id: str
):
    """
    Re-judge a single criterion for a hunt.
    Returns updated judge_criteria and recalculated score.
    """
    session = hunt_engine.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    
    # Find hunt result
    result = next((r for r in session.results if r.hunt_id == hunt_id), None)
    if not result:
        raise HTTPException(404, "Hunt result not found")
    
    # Get criterion from response_reference
    criteria_list = await judge_client._extract_criteria(
        session.notebook.response_reference,
        session.config.judge_model
    )
    criterion = next((c for c in criteria_list if c['id'] == criterion_id), None)
    if not criterion:
        raise HTTPException(404, "Criterion not found")
    
    # Re-judge single criterion
    eval_result = await judge_client._evaluate_single_criterion(
        prompt=session.notebook.prompt,
        student_response=result.response,
        criterion=criterion,
        model=session.config.judge_model
    )
    
    # Update judge_criteria
    if not result.judge_criteria:
        result.judge_criteria = {}
    result.judge_criteria[criterion_id] = eval_result['status']
    
    # Recalculate overall score
    all_criteria = result.judge_criteria
    pass_count = sum(1 for v in all_criteria.values() if v.upper() == 'PASS')
    total_count = len(all_criteria)
    pass_rate = pass_count / total_count if total_count > 0 else 0
    result.judge_score = 1 if pass_rate > 0.5 else 0
    result.is_breaking = result.judge_score == 0
    
    return {
        "criterion_id": criterion_id,
        "status": eval_result['status'],
        "reason": eval_result['reason'],
        "updated_score": result.judge_score,
        "is_breaking": result.is_breaking,
        "all_criteria": result.judge_criteria
    }
```

### Frontend State Management
- Need to track which criteria are being re-judged (loading states)
- Need to update UI reactively when criteria change
- Need to handle errors gracefully

### Cost Implications
- Feature 2 adds API calls (GPT-5 per criterion)
- Estimate: ~$0.01-0.02 per re-judge (depending on criterion length)
- Should add rate limiting or confirmation dialogs

---

## Recommendations

### ✅ Implement First (High Value, Low Risk)
1. **Feature 1**: Show judge criteria immediately
2. **Feature 3**: Unlock selection flexibility

### ⚠️ Implement Second (Medium Value, Medium Risk)
3. **Feature 2**: Individual criterion re-judging
   - Add confirmation dialog to prevent abuse
   - Add rate limiting (max 10 re-judges per hunt)
   - Show cost estimate if possible

### 🚫 Consider Skipping If
- Cost is a major concern (Feature 2)
- Trainers don't request it after seeing Feature 1
- Time constraints are tight

---

## Testing Checklist

### Feature 1
- [ ] Judge criteria visible immediately after hunt completes
- [ ] Criteria breakdown shows correct PASS/FAIL status
- [ ] Judge explanation is readable and formatted correctly
- [ ] Works with 1, 5, 10+ criteria
- [ ] Mobile responsive

### Feature 2
- [ ] Re-judge button works for each criterion
- [ ] Loading state shows during API call
- [ ] Score recalculates correctly after re-judge
- [ ] Error handling works (API failure, network issues)
- [ ] Rate limiting prevents abuse
- [ ] Concurrent re-judges handled correctly

### Feature 3
- [ ] Can change selection before starting reviews
- [ ] Can change selection after starting reviews (with warning)
- [ ] Cannot change selection after revealing LLM judgments
- [ ] Validation still works correctly
- [ ] No data loss when changing selection

---

## Questions to Resolve

1. **Feature 2**: Should re-judge update the original hunt result or create a new version?
   - **Recommendation**: Update original (simpler, but loses history)

2. **Feature 2**: Should we limit number of re-judges per hunt?
   - **Recommendation**: Yes, max 10 per hunt to prevent abuse

3. **Feature 3**: What happens to reviews if selection changes?
   - **Recommendation**: Keep reviews for all hunts, but only use selected ones for export

4. **Feature 1**: Should we show criteria in progress table or only in cards?
   - **Recommendation**: Summary in table, full details in cards

5. **All Features**: Should these be configurable (on/off)?
   - **Recommendation**: No, keep it simple - always on
