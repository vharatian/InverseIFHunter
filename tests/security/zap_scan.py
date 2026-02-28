"""
Security scan using OWASP ZAP proxy.

Prerequisites:
  1. Install ZAP: brew install zaproxy (or download from zaproxy.org)
  2. Start ZAP daemon: zap.sh -daemon -host 127.0.0.1 -port 8888 -config api.key=changeme
  3. pip install python-owasp-zap-v2.4
  4. Start the Model Hunter server: python -m uvicorn main:app --port 8000

Usage:
  python tests/security/zap_scan.py
"""
import time
import sys

TARGET = "http://localhost:8000"
ZAP_API_KEY = "changeme"
ZAP_PROXY = "http://127.0.0.1:8888"


def run_security_scan():
    try:
        from zapv2 import ZAPv2
    except ImportError:
        print("ERROR: python-owasp-zap-v2.4 not installed.")
        print("  pip install python-owasp-zap-v2.4")
        sys.exit(1)

    zap = ZAPv2(
        apikey=ZAP_API_KEY,
        proxies={"http": ZAP_PROXY, "https": ZAP_PROXY},
    )

    # Spider the target
    print(f"Spidering {TARGET}...")
    scan_id = zap.spider.scan(TARGET)
    while int(zap.spider.status(scan_id)) < 100:
        print(f"  Spider progress: {zap.spider.status(scan_id)}%")
        time.sleep(2)
    print("  Spider complete.")

    # Passive scan (automatic during spider)
    print("Waiting for passive scan...")
    while int(zap.pscan.records_to_scan) > 0:
        print(f"  Passive scan remaining: {zap.pscan.records_to_scan}")
        time.sleep(1)
    print("  Passive scan complete.")

    # Active scan
    print("Starting active scan...")
    scan_id = zap.ascan.scan(TARGET)
    while int(zap.ascan.status(scan_id)) < 100:
        print(f"  Active scan progress: {zap.ascan.status(scan_id)}%")
        time.sleep(5)
    print("  Active scan complete.")

    # Report
    alerts = zap.core.alerts()
    high = [a for a in alerts if a["risk"] == "High"]
    medium = [a for a in alerts if a["risk"] == "Medium"]
    low = [a for a in alerts if a["risk"] == "Low"]
    info = [a for a in alerts if a["risk"] == "Informational"]

    print(f"\n{'=' * 50}")
    print("SECURITY SCAN RESULTS")
    print(f"{'=' * 50}")
    print(f"  High:          {len(high)}")
    print(f"  Medium:        {len(medium)}")
    print(f"  Low:           {len(low)}")
    print(f"  Informational: {len(info)}")
    print(f"  Total:         {len(alerts)}")

    for alert in high + medium:
        print(f"\n  [{alert['risk']}] {alert['alert']}")
        print(f"    URL: {alert['url']}")
        print(f"    Description: {alert['description'][:200]}")

    # Save HTML report
    report_path = "security_report.html"
    with open(report_path, "w") as f:
        f.write(zap.core.htmlreport())
    print(f"\nFull report saved to {report_path}")

    # Fail if high-severity issues found
    assert len(high) == 0, f"Found {len(high)} high-severity vulnerabilities!"
    print("\nSECURITY SCAN PASSED — no high-severity issues found.")


if __name__ == "__main__":
    run_security_scan()
