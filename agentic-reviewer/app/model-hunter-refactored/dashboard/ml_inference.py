"""
ML Inference Module for Break Prediction

Loads pre-trained scikit-learn model artifacts (.joblib) and provides:
- predict_break_probability(): Score a hunt configuration
- what_if(): Interactive parameter tweaking
- get_model_info(): Model metadata

Gracefully degrades if no model artifact is found.
"""
import os
import json
from typing import Dict, Any, Optional, List

# Optional imports
try:
    import joblib
    _joblib_available = True
except ImportError:
    _joblib_available = False


class MLInference:
    """Load and serve ML break prediction model."""

    def __init__(self, model_dir: Optional[str] = None):
        self.model = None
        self.metadata = {}
        self.feature_names: List[str] = []
        self._loaded = False

        if not _joblib_available:
            return

        # Find model artifacts
        if model_dir:
            model_path = os.path.join(model_dir, "break_predictor.joblib")
            meta_path = os.path.join(model_dir, "model_metadata.json")
        else:
            # Check common paths
            candidates = [
                os.environ.get("ML_MODEL_PATH", ""),
                "/app/ml_models",
                os.path.join(os.path.dirname(__file__), "..", "ml_pipeline", "models"),
                os.path.join(os.path.dirname(__file__), "models"),
            ]
            model_path = None
            meta_path = None
            for d in candidates:
                if d and os.path.exists(os.path.join(d, "break_predictor.joblib")):
                    model_path = os.path.join(d, "break_predictor.joblib")
                    meta_path = os.path.join(d, "model_metadata.json")
                    break

        if not model_path or not os.path.exists(model_path):
            print("ML model artifact not found - ML features disabled")
            return

        try:
            self.model = joblib.load(model_path)
            if meta_path and os.path.exists(meta_path):
                with open(meta_path, "r") as f:
                    self.metadata = json.load(f)
            self.feature_names = self.metadata.get("feature_names", [
                "num_criteria", "has_formatting_criteria", "model_is_qwen",
                "prompt_length", "reasoning_budget"
            ])
            self._loaded = True
            print(f"ML model loaded: {self.get_model_info()}")
        except Exception as e:
            print(f"Error loading ML model: {e}")

    def is_loaded(self) -> bool:
        return self._loaded

    def get_model_info(self) -> Dict[str, Any]:
        if not self._loaded:
            return {"loaded": False, "message": "No model artifact found"}
        return {
            "loaded": True,
            "accuracy": self.metadata.get("accuracy", "unknown"),
            "trained_at": self.metadata.get("trained_at", "unknown"),
            "n_samples": self.metadata.get("n_samples", "unknown"),
            "features": self.feature_names,
        }

    def predict_break_probability(self, features: Dict[str, Any]) -> Optional[float]:
        """
        Predict break probability for a hunt configuration.
        
        Args:
            features: Dict with keys matching feature_names
            
        Returns:
            Probability 0.0-1.0, or None if model not loaded
        """
        if not self._loaded:
            return None

        try:
            # Build feature vector in correct order
            feature_vector = []
            for name in self.feature_names:
                val = features.get(name, 0)
                if isinstance(val, bool):
                    val = 1 if val else 0
                feature_vector.append(float(val))

            # predict_proba returns [[prob_0, prob_1]]
            if hasattr(self.model, "predict_proba"):
                proba = self.model.predict_proba([feature_vector])[0]
                return round(float(proba[1]), 4)  # prob of class 1 (breaking)
            else:
                pred = self.model.predict([feature_vector])[0]
                return round(float(pred), 4)
        except Exception as e:
            print(f"ML prediction error: {e}")
            return None

    def what_if(self, base_features: Dict[str, Any], changes: Dict[str, Any]) -> Dict[str, Any]:
        """
        What-if simulator: compute base probability and changed probability.
        
        Returns: {"base_probability": float, "new_probability": float, "delta": float}
        """
        if not self._loaded:
            return {"error": "Model not loaded"}

        base_prob = self.predict_break_probability(base_features)
        changed_features = {**base_features, **changes}
        new_prob = self.predict_break_probability(changed_features)

        if base_prob is None or new_prob is None:
            return {"error": "Prediction failed"}

        return {
            "base_probability": base_prob,
            "new_probability": new_prob,
            "delta": round(new_prob - base_prob, 4),
        }
