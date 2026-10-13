import sys, openpyxl
src, out = sys.argv[1], sys.argv[2]
wb = openpyxl.load_workbook(src)
ws = wb["01_CONTROL"]
for col, v in enumerate(["BCP-1", "BCP-FIXTURE-1", "00000000-0000-4000-8000-000000000001", "CDF-DEMO-2026-0001",
                         "2026-10-01T08:00:00Z", "2026-10-02T17:00:00Z", "lead@example.test"], start=1):
    ws.cell(row=3, column=col, value=v)
ws = wb["05_SUBJECTS"]
for col, v in enumerate(["BCP-S1", None, "2026-10-01T09:30:00Z", "lead@example.test", "الموظف أوميغا (تجريبي)", "EMPLOYEE"], start=1):
    ws.cell(row=3, column=col, value=v)
for col, v in enumerate(["BCP-S2", None, "2026-10-01T10:00:00Z", "lead@example.test", "Employee Psi & <Co> (synthetic)", "CONTRACTOR"], start=1):
    ws.cell(row=4, column=col, value=v)
ws = wb["06_ALLEGATIONS"]
row = ["BCP-A1", None, "2026-10-01T11:00:00Z", "lead@example.test", "MISCONDUCT", "Synthetic: allegation recorded during the outage.\nSecond line.", "BCP-S1", None, None]
for col, v in enumerate(row, start=1):
    ws.cell(row=3, column=col, value=v)
# Things the importer must see as they are: a number, a formula, a typed date.
ws = wb["02_CASE_MASTER"]
ws.cell(row=3, column=1, value="BCP-C1")
ws.cell(row=3, column=3, value="=TODAY()")
ws.cell(row=3, column=4, value="lead@example.test")
ws.cell(row=3, column=6, value=42)
wb.save(out)
