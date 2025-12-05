#!/usr/bin/env python3

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from sklearn.inspection import permutation_importance
import shap
import joblib
import os

# -------------------------------------------------------------------------
# Create output folder
# -------------------------------------------------------------------------

OUTPUT_DIR = "final_plots"
os.makedirs(OUTPUT_DIR, exist_ok=True)

def savefig(name):
    """Helper to save plots inside final_plots/ directory."""
    path = os.path.join(OUTPUT_DIR, name)
    plt.savefig(path, dpi=200)
    print(f"Saved: {path}")
    return path

# -------------------------------------------------------------------------
# Load model + data
# -------------------------------------------------------------------------

pipe = joblib.load("model_pipe.pkl")
X_test = joblib.load("X_test.pkl")
y_test = joblib.load("y_test.pkl")
NUMERIC_FEATS = joblib.load("numeric_feats.pkl")
CAT_FEATS = joblib.load("cat_feats.pkl")

y_test = np.array(y_test)
y_pred = pipe.predict(X_test)

columns = NUMERIC_FEATS + CAT_FEATS
X_test_df = pd.DataFrame(X_test, columns=columns)

# -------------------------------------------------------------------------
# 1. Predicted vs Actual
# -------------------------------------------------------------------------

plt.figure(figsize=(7, 7))
plt.scatter(y_test, y_pred, alpha=0.6)
plt.plot([y_test.min(), y_test.max()],
         [y_test.min(), y_test.max()],
         'r--', label="Perfect prediction")

plt.xlabel("Actual GA90 Next Season")
plt.ylabel("Predicted GA90")
plt.title("Predicted vs Actual (Hold-Out Pair)")
plt.legend()
plt.grid(alpha=0.3)
plt.tight_layout()
savefig("pred_vs_actual.png")
plt.close()

# -------------------------------------------------------------------------
# 2. Residual Histogram
# -------------------------------------------------------------------------

residuals = y_test - y_pred

plt.figure(figsize=(7, 5))
plt.hist(residuals, bins=25, alpha=0.8, color='purple')
plt.axvline(0, color='red', linestyle='--')

plt.xlabel("Residual (Actual - Predicted)")
plt.ylabel("Frequency")
plt.title("Residual Distribution")
plt.grid(alpha=0.3)
plt.tight_layout()
savefig("residual_hist.png")
plt.close()

# -------------------------------------------------------------------------
# 3. Residuals vs Minutes
# -------------------------------------------------------------------------

if "Minutes" in X_test_df.columns:
    mins = X_test_df["Minutes"]
else:
    mins = np.zeros_like(y_test)

plt.figure(figsize=(7, 5))
plt.scatter(mins, residuals, alpha=0.6)
plt.axhline(0, color='red', linestyle='--')

plt.xlabel("Minutes (Previous Season)")
plt.ylabel("Residual (Actual - Predicted)")
plt.title("Residuals vs Minutes")
plt.grid(alpha=0.3)
plt.tight_layout()
savefig("residuals_vs_minutes.png")
plt.close()

# -------------------------------------------------------------------------
# 4. Permutation Feature Importance
# -------------------------------------------------------------------------

print("Computing permutation importance...")

result = permutation_importance(
    pipe, X_test, y_test, n_repeats=10, random_state=42
)

importances = result.importances_mean
std = result.importances_std
features = columns

sorted_idx = np.argsort(importances)

plt.figure(figsize=(10, 6))
plt.barh(
    np.array(features)[sorted_idx],
    importances[sorted_idx],
    xerr=std[sorted_idx] * 1.5,
    color='steelblue'
)
plt.xlabel("Importance (Permutation Drop in Score)")
plt.ylabel("Feature")
plt.title("Permutation Feature Importance")
plt.tight_layout()
savefig("permutation_importance.png")
plt.close()

# -------------------------------------------------------------------------
# 5. SHAP Feature Importance (fixed)
# -------------------------------------------------------------------------

print("Computing SHAP values... (this may take ~10 seconds)")

preprocessor = pipe.named_steps["preprocess"]
model = pipe.named_steps["model"]

X_test_transformed = preprocessor.transform(X_test)
sample_transformed = X_test_transformed[:300]

explainer = shap.TreeExplainer(model)
shap_values = explainer.shap_values(sample_transformed)

ohe = preprocessor.named_transformers_['cat']
cat_feature_names = ohe.get_feature_names_out(CAT_FEATS)
numeric_feature_names = NUMERIC_FEATS
all_feature_names = list(numeric_feature_names) + list(cat_feature_names)

shap_df = pd.DataFrame(sample_transformed, columns=all_feature_names)

plt.figure(figsize=(12, 6))
shap.summary_plot(shap_values, shap_df, feature_names=all_feature_names, show=False)
plt.tight_layout()
savefig("shap_summary.png")
plt.close()

print("\nAll plots saved inside final_plots/ folder.\n")
