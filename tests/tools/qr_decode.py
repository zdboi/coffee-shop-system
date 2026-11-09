# QR decoder for tests/e2e/bo_menuqr.e2e.js (OpenCV). Prints '<width>x<height>|<decoded text>'.
# Usage: python3 -I tests/tools/qr_decode.py <image> [scale]   (from back-office-dev's bo142-decode.py, 2026-11-10)
import sys, cv2
img = cv2.imread(sys.argv[1])
if len(sys.argv) > 2: img = cv2.resize(img, None, fx=float(sys.argv[2]), fy=float(sys.argv[2]), interpolation=cv2.INTER_NEAREST)
d = cv2.QRCodeDetector()
txt, pts, _ = d.detectAndDecode(img)
print(f"{img.shape[1]}x{img.shape[0]}|{txt}")
