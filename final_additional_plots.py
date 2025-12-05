#!/usr/bin/env python3

import os
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
import shap
import joblib

# --------------------------------------------------------------------
# Create output folder
# --------------------------------------------------------------------

OUTPUT_DIR = "final_plots"
os.makedirs(OUTPUT_DIR, exist_ok=True)

def savefig(name):
    """Helper function to save files inside final_plots/."""
    path = os.path.join(OUTPUT_DIR, name)
    plt.savefig(path, dpi=200, bbox_inches="tight")
    print(f"Saved: {path}")
    return path

# --------------------------------------------------------------------
# Load model + testing data
# --------------------------------------------------------------------

pipe = joblib.load("model_pipe.pkl")
X_test = joblib.load("X_test.pkl")
y_test = joblib.load("y_test.pkl")
NUMERIC_FEATS = joblib.load("numeric_feats.pkl")
CAT_FEATS = joblib.load("cat_feats.pkl")

y_pred = pipe.predict(X_test)
X_test_df = pd.DataFrame(X_test, columns=NUMERIC_FEATS + CAT_FEATS)

# Load preprocessor + underlying model
preprocessor = pipe.named_steps["preprocess"]
model = pipe.named_steps["model"]

# --------------------------------------------------------------------
# (1) GA90 YEAR-TO-YEAR CORRELATION PLOT
# --------------------------------------------------------------------

def load_season(path):
    df = pd.read_csv(path)
    df["GA90"] = (df["Goals"] / df["Minutes"] * 90).replace([np.inf, -np.inf], np.nan)
    return df[["Player Name", "Minutes", "Goals", "Assists", "GA90"]]

pairs = [
    ("2022/23", "epl_players_2022_23_fbref_like.csv",
     "2023/24", "epl_players_2023_24_fbref_like.csv"),
    ("2023/24", "epl_players_2023_24_fbref_like.csv",
     "2024/25", "epl_player_stats_24_25.csv"),
]

for (label_prev, file_prev, label_next, file_next) in pairs:
    df_prev = load_season(file_prev)
    df_next = load_season(file_next)

    merged = df_prev.merge(df_next, on="Player Name", suffixes=("_prev", "_next"))
    merged = merged.dropna(subset=["GA90_prev", "GA90_next"])

    plt.figure(figsize=(7, 7))
    plt.scatter(merged["GA90_prev"], merged["GA90_next"], alpha=0.6)
    plt.xlabel(f"GA90 in {label_prev}")
    plt.ylabel(f"GA90 in {label_next}")
    plt.title(f"Year-to-Year GA90 Correlation ({label_prev} → {label_next})")
    plt.grid(alpha=0.3)

    # correlation coefficient
    corr = merged["GA90_prev"].corr(merged["GA90_next"])
    plt.text(0.05, 0.9, f"Correlation = {corr:.3f}", transform=plt.gca().transAxes)

    savefig(f"ga90_corr_{label_prev.replace('/', '-')}_to_{label_next.replace('/', '-')}.png")
    plt.close()

# --------------------------------------------------------------------
# (2) FEATURE CORRELATION HEATMAP
# --------------------------------------------------------------------

plt.figure(figsize=(12, 10))
corr = X_test_df[NUMERIC_FEATS].corr()
sns.heatmap(corr, annot=True, fmt=".2f", cmap="coolwarm")
plt.title("Feature Correlation Heatmap")
savefig("feature_correlation_heatmap.png")
plt.close()

# --------------------------------------------------------------------
# (3) POSITION-WISE DISTRIBUTION OF PREDICTED GA90
# --------------------------------------------------------------------

X_test_with_preds = X_test_df.copy()
X_test_with_preds["pred_GA90_next"] = y_pred

plt.figure(figsize=(10, 6))
sns.boxplot(data=X_test_with_preds, x="pos_bucket", y="pred_GA90_next")
plt.xlabel("Position Bucket")
plt.ylabel("Predicted GA90 Next Season")
plt.title("Predicted GA90 Distribution by Position")
savefig("pred_ga90_by_position.png")
plt.close()

# --------------------------------------------------------------------
# (4) SHAP DEPENDENCE PLOTS (TOP 3 FEATURES)
# --------------------------------------------------------------------

# Transform X_test using preprocessor
X_transformed = preprocessor.transform(X_test)

# One-hot feature names
ohe = preprocessor.named_transformers_['cat']
cat_names = list(ohe.get_feature_names_out(CAT_FEATS))
all_feature_names = NUMERIC_FEATS + cat_names

# Build DataFrame of transformed features
X_trans_df = pd.DataFrame(X_transformed, columns=all_feature_names)

# Compute SHAP
explainer = shap.TreeExplainer(model)
shap_vals = explainer.shap_values(X_transformed)

# Get mean absolute SHAP values and find top 3 features
mean_abs = np.abs(shap_vals).mean(axis=0)
top3_idx = np.argsort(mean_abs)[-3:]
top3_features = [all_feature_names[i] for i in top3_idx]

for feat in top3_features:
    plt.figure(figsize=(7, 5))
    shap.dependence_plot(feat, shap_vals, X_trans_df, show=False)
    plt.title(f"SHAP Dependence Plot: {feat}")
    savefig(f"shap_dependence_{feat}.png")
    plt.close()

# --------------------------------------------------------------------
# (5) ERROR vs TRUE GA90
# --------------------------------------------------------------------

residuals = y_test - y_pred

plt.figure(figsize=(7, 5))
plt.scatter(y_test, residuals, alpha=0.6)
plt.axhline(0, color='red', linestyle='--')
plt.xlabel("Actual GA90 Next Season")
plt.ylabel("Residual (Actual - Predicted)")
plt.title("Residuals vs Actual GA90")
plt.grid(alpha=0.3)
savefig("residuals_vs_actual_ga90.png")
plt.close()

# --------------------------------------------------------------------
# (6) ERROR BY POSITION BUCKET
# --------------------------------------------------------------------

X_test_with_preds["residual"] = residuals

plt.figure(figsize=(10, 6))
sns.boxplot(data=X_test_with_preds, x="pos_bucket", y="residual")
plt.axhline(0, color='red', linestyle='--')
plt.xlabel("Position Bucket")
plt.ylabel("Residual")
plt.title("Prediction Error by Position Bucket")
savefig("residuals_by_position.png")
plt.close()

# --------------------------------------------------------------------
# Done
# --------------------------------------------------------------------

print("\nAll additional plots saved inside final_plots/ folder.\n")
