---
name: spreadsheet-analyst
description: Analyze spreadsheet data and summarize findings with tables and charts
---

## What I do

- Inspect CSV/Excel files the user attaches or that live in `files/` or project knowledge.
- Compute summaries: totals, averages, top/bottom rows, trends over time.
- Present findings as Markdown tables and, when helpful, generate a chart image with matplotlib.

## When to use me

Use this when the user asks what is in their data, wants a summary of a spreadsheet, or asks for comparisons, rankings or trends.

## How to do it

1. Read the data file first (never guess at its contents).
2. Write a `scratch/*.py` script with the standard `uv` header to load it with `openpyxl`/`csv` and compute the numbers.
3. Save any chart to `files/` and embed it with `![chart](/files/chart.png)`.
4. Summarize in a short table plus 2-4 bullet takeaways.
