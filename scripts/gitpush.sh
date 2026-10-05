#!/bin/bash
# Usage: gitpush.sh <message-file>. Stages everything, refuses if any .env value or key pattern is in ANY tracked file (not just this commit's changes), commits, pushes.
set -e
cd "$(dirname "$0")/.."
rm -f .git/index.lock
git add -A
git diff --cached --name-only > /tmp/rall-e-staged.txt
[ -s /tmp/rall-e-staged.txt ] || { echo "nothing to commit"; exit 0; }
git ls-files -z > /tmp/rall-e-tracked.txt
python3 - <<'PY'
import os,re,sys
home=os.path.expanduser('~'); root=os.getcwd(); vals={}
for line in open(f'{root}/.env',encoding='utf-8',errors='ignore'):
    line=line.strip()
    if '=' in line and not line.startswith('#'):
        k,v=line.split('=',1); v=v.strip().strip('"')
        if len(v)>=12 and not v.startswith('http') and not re.fullmatch(r'[+\d,]+',v): vals[k]=v
pat=re.compile(r'(sk-ant-[\w-]{10,}|github_pat_\w{10,}|ghp_\w{20,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|sk_(live|test)_\w{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bSK[0-9a-f]{32}\b)')
hits=[]
for f in open('/tmp/rall-e-tracked.txt',encoding='utf-8').read().split('\0'):  # every tracked file; NUL-separated so names with spaces are read
    if not f: continue
    p=os.path.join(root,f)
    if not os.path.isfile(p): continue
    t=open(p,encoding='utf-8',errors='ignore').read()
    hits+=[f'{f}: value of {k}' for k,v in vals.items() if v in t]+[f'{f}: key pattern' for m in pat.finditer(t)]
if hits: print('SECRET FOUND, not committing:\n'+'\n'.join(hits)); sys.exit(1)
print(f'secret scan clean ({len(vals)} env values checked)')
PY
git -c user.name="${GIT_NAME:-Jeffrey Davis}" -c user.email="${GIT_EMAIL:-jeffreyd.davis@gmail.com}" commit -q -F "$1"
export GITHUB_TOKEN=$(grep -E '^GITHUB_TOKEN=' .env | tail -1 | cut -d= -f2- | tr -d '\r" ')
printf '#!/bin/sh\ncase "$1" in *Username*) echo x-access-token;; *) echo "$GITHUB_TOKEN";; esac\n' > $HOME/askpass.sh; chmod 700 $HOME/askpass.sh
GIT_ASKPASS=$HOME/askpass.sh GIT_TERMINAL_PROMPT=0 git -c credential.helper= push -q origin master; rc=$?
rm -f $HOME/askpass.sh
git log --oneline -1; git status -sb | head -1; exit $rc
