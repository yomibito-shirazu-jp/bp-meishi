import sys
import re

with open('backend/main.py.bak', 'r', encoding='utf-8') as f:
    old = f.read()

# extract rebuild
rebuild_match = re.search(r'(@app\.post\(\"/rebuild\"\).*?)(?=@app\.post|if __name__)', old, re.DOTALL)
rebuild_code = rebuild_match.group(1) if rebuild_match else ""
    
# extract extract_corrections
extract_match = re.search(r'(class CorrectionTask.*?@app\.post\(\"/extract-corrections\"\).*?)(?=@app\.post|if __name__)', old, re.DOTALL)
extract_code = extract_match.group(1) if extract_match else ""

with open('backend/main.py', 'a', encoding='utf-8') as f:
    if rebuild_code:
        f.write('\n\n')
        f.write(rebuild_code)
    if extract_code:
        f.write('\n\n')
        f.write(extract_code)

print("Appended endpoints.")
