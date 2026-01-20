# Criteria Workflow - Complete Explanation

## What is `initialCriteria`?

`initialCriteria` is a **snapshot** of all criteria from the notebook's `response_reference` when the notebook is **first loaded**. It's stored in the browser's memory and **never changes** (even if you edit the notebook in Colab later).

### Example in Notebook:

In a Colab notebook, you have a cell with heading `**[response_reference]**`:

```markdown
**[response_reference]**

Each criterion is evaluated independently as PASS or FAIL.

To earn 1 point (PASS), the student's answer must PASS more than 50% of the criteria listed below:

[
  { "id": "C1", "criteria1": "Does the response explicitly state that none of the provided options (84, 88, 36, 92) are correct?" },
  { "id": "C2", "criteria2": "Does the response identify the core flaw: that 'Kryptonite' is a fictional substance (popularized by Superman comics) and not a real chemical element?" },
  { "id": "C3", "criteria3": "Does the response clarify the historical fact that while Marie Curie did discover elements in 1898 (specifically Polonium and Radium), she did not discover Kryptonite?" },
  { "id": "C4", "criteria4": "Does the response distinguish between the real element 'Krypton' (Option C) and the fictional 'Kryptonite,' confirming that the latter has no place on the Periodic Table?" }
]

Failure to PASS more than 50% of the above criteria will result in a score of 0 points (FAIL).
```

## Complete Workflow

### Step 1: Notebook Load (First Time)

**What happens:**
1. User loads notebook from Colab URL
2. Backend parses notebook and extracts `response_reference` from `**[response_reference]**` cell
3. Frontend receives notebook data
4. Frontend parses criteria from `response_reference` JSON array

**Example:**
```javascript
// Notebook has response_reference with C1, C2, C3, C4
notebook.response_reference = `
[
  { "id": "C1", "criteria1": "..." },
  { "id": "C2", "criteria2": "..." },
  { "id": "C3", "criteria3": "..." },
  { "id": "C4", "criteria4": "..." }
]
`

// Frontend parses it
parsedCriteria = [
  { id: "C1", criteria: "..." },
  { id: "C2", criteria: "..." },
  { id: "C3", criteria: "..." },
  { id: "C4", criteria: "..." }
]

// Store in state
state.criteria = parsedCriteria  // Current criteria (can change)
state.initialCriteria = deepCopy(parsedCriteria)  // Snapshot (NEVER changes)
```

**Result:**
- `state.initialCriteria` = [C1, C2, C3, C4] ← **This is the "source of truth"**
- `state.criteria` = [C1, C2, C3, C4]

---

### Step 2: User Edits Notebook in Colab

**Scenario:** User removes C2 and C3 from `response_reference` in Colab

**In Colab, response_reference now has:**
```json
[
  { "id": "C1", "criteria1": "..." },
  { "id": "C4", "criteria4": "..." }
]
```

**In Frontend:**
- `state.initialCriteria` = [C1, C2, C3, C4] ← **Still has all 4 (never changes)**
- `state.criteria` = [C1, C4] ← **Updated when notebook is re-fetched**

---

### Step 3: User Clicks "Judge Only"

**What happens:**
1. Frontend calls `/api/judge-reference/{session_id}`
2. Backend re-fetches notebook from Colab (gets latest `response_reference`)
3. Backend judges the response against current `response_reference` (C1, C4 only)
4. Judge returns: `{ "C1": "PASS", "C4": "PASS" }`
5. Frontend receives judge result

**Frontend Processing:**
```javascript
// Judge result
criteria = { "C1": "PASS", "C4": "PASS" }

// Re-parse current criteria from fresh response_reference
currentCriteria = parseCriteria(data.response_reference)  // [C1, C4]
state.criteria = currentCriteria

// Compare with initialCriteria
initialCriteriaIds = ["C1", "C2", "C3", "C4"]
currentCriteriaIds = ["C1", "C4"]
missingCriteriaIds = ["C2", "C3"]  // In initial but not in current

// Add missing criteria to judge result
criteria["C2"] = "MISSING"
criteria["C3"] = "MISSING"

// Final criteria object
criteria = {
  "C1": "PASS",
  "C2": "MISSING",  // Added because in initialCriteria
  "C3": "MISSING",  // Added because in initialCriteria
  "C4": "PASS"
}
```

**Display:**
- C1: ✅ PASS
- C2: ⚠️ MISSING (from initialCriteria)
- C3: ⚠️ MISSING (from initialCriteria)
- C4: ✅ PASS

---

### Step 4: Display Logic

**`formatJudgeCriteriaDisplay(criteria)` function:**
1. Takes judge result: `{ "C1": "PASS", "C4": "PASS" }`
2. Checks `state.initialCriteria` = [C1, C2, C3, C4]
3. Adds missing ones: `criteria["C2"] = "MISSING"`, `criteria["C3"] = "MISSING"`
4. Sorts by ID: C1, C2, C3, C4
5. Displays all with descriptions from `initialCriteria`

---

## Key Points

### 1. `initialCriteria` is Set ONCE
- Set when notebook is **first loaded**
- **Never overwritten** (even if notebook is re-fetched)
- This is the "original state" snapshot

### 2. `state.criteria` Can Change
- Updated when notebook is re-fetched
- Reflects current state of `response_reference` in Colab
- Used for current validation

### 3. Missing Detection
- Compares `initialCriteria` (original) vs `currentCriteria` (current)
- If criterion is in `initialCriteria` but not in `currentCriteria` → MISSING
- Only criteria that **existed originally** are marked as missing

### 4. Display Logic
- Shows ALL criteria from `initialCriteria`
- Missing ones are marked as MISSING
- Present ones show their judge status (PASS/FAIL)

---

## Example Scenarios

### Scenario 1: All Criteria Present
**Initial:** C1, C2, C3, C4
**Current:** C1, C2, C3, C4
**Result:** All shown, all judged

### Scenario 2: Some Criteria Removed
**Initial:** C1, C2, C3, C4
**Current:** C1, C4
**Result:** C1 ✅, C2 ⚠️ MISSING, C3 ⚠️ MISSING, C4 ✅

### Scenario 3: Non-Sequential IDs
**Initial:** C1, C2, C17
**Current:** C1, C17
**Result:** C1 ✅, C2 ⚠️ MISSING, C17 ✅
**Note:** C3-C16 are NOT marked as missing (they never existed)

### Scenario 4: Notebook Loaded After Edit
**Initial:** C1, C4 (notebook was already edited when loaded)
**Current:** C1, C4
**Result:** C1 ✅, C4 ✅
**Note:** C2, C3 won't be detected as missing because they're not in `initialCriteria`

---

## Why This Design?

1. **Preserves Original State**: `initialCriteria` captures what the notebook had when first loaded
2. **Detects Removals**: Can detect if criteria were removed after initial load
3. **Handles Any Number**: Works with 4 criteria or 17 criteria
4. **Non-Sequential Support**: Handles C1, C2, C17 without false positives

---

## Code Locations

- **Set initialCriteria**: `static/app.js` line 577-578
- **Detect Missing**: `static/app.js` line 2395-2440
- **Display Criteria**: `static/app.js` line 2017-2072
- **Parse Criteria**: `static/app.js` line 642-730
- **Extract from Notebook**: `services/notebook_parser.py` line 317-318

