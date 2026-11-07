# IT Support Toolkit — itsupport.hizarc.com

Password-protected IT support library: commands, scripts, troubleshooting methods and links,
with search and one-click copy. 100% static — hosted free on GitHub Pages, no backend.

> **Malayalam guide below** — മലയാളം വിശദീകരണം താഴെ.

---

## ഇത് എങ്ങനെ പ്രവർത്തിക്കുന്നു

- Backend / server ഇല്ല. എല്ലാ content-ഉം **`docs/data.enc.json`** എന്ന ഒരു file-ൽ **AES-256 encryption** ചെയ്ത് ആണ് GitHub-ൽ ഇടുന്നത്.
- Login ചെയ്യുമ്പോൾ നിങ്ങളുടെ **username + password** ഉപയോഗിച്ച് browser-ൽ തന്നെ ആ file decrypt ചെയ്യുന്നു.
  Password തെറ്റിയാൽ decrypt ആവില്ല — content കാണാൻ കഴിയില്ല.
- Password എവിടെയും save ചെയ്യുന്നില്ല. GitHub repo public ആണെങ്കിലും ആർക്കും content വായിക്കാൻ പറ്റില്ല (encrypted ആണ്).
- അതുകൊണ്ട് **strong password** വേണം (കുറഞ്ഞത് 12 characters — ഒരു ചെറിയ sentence നല്ലതാണ്).
- Tab close ചെയ്താലോ 15 minute ഒന്നും ചെയ്യാതിരുന്നാലോ auto logout ആകും. Logout ചെയ്യുമ്പോൾ clipboard-ഉം clear ആകും.

## Content — Windows, Mac, Linux

| Section | Categories |
|---|---|
| Windows | Network, System, Power/Boot, Windows Update, Users/AD, Entra/Intune, Printers, Microsoft 365, Disk, Processes, Security, Remote, Software, Shortcuts, Troubleshooting |
| 🍎 Mac | System & Health · Network & Wi-Fi · Users, MDM & Security · Microsoft 365 & Apps · Printers, Disk & Files · Troubleshooting & Shortcuts |
| 🐧 Linux | System & Services · Network & Firewall · Users, Permissions & Security · Disk, Files & Packages · Troubleshooting & Cheat Sheet |
| Links | Admin portals · Tools & downloads · Docs & online checkers |

Website Windows PC, Mac (Safari / Chrome), Linux, phone — എല്ലാത്തിലും പ്രവർത്തിക്കും.
Mac-ൽ copy ചെയ്ത command **Terminal**-ൽ paste ചെയ്യുക (Cmd + V).

## Folder structure

| Folder / file | എന്ത് | GitHub-ൽ പോകുമോ? |
|---|---|---|
| `content/*.md` | നിങ്ങളുടെ commands / tips (plain text, edit ചെയ്യാൻ) | **ഇല്ല** (`.gitignore`) |
| `content/online/*.md` | Website-ലെ **➕ Add** വഴി ചേർത്തവ (deploy ചെയ്യുമ്പോൾ ഇവിടെ വരും) | **ഇല്ല** |
| `docs/` | Website (GitHub Pages ഈ folder publish ചെയ്യും) | ഉണ്ട് |
| `docs/data.enc.json` | Encrypted content | ഉണ്ട് (encrypted) |
| `docs/CNAME` | `itsupport.hizarc.com` | ഉണ്ട് |
| `tools/build.mjs` | content encrypt ചെയ്യുന്ന script | ഉണ്ട് |

## 1. ആദ്യമായി — login set ചെയ്യുക

Windows-ൽ PowerShell, Mac / Linux-ൽ Terminal — ഈ folder-ൽ തുറന്ന് (commands എല്ലാത്തിലും ഒന്നുതന്നെ):

```
npm run build
```

Username, password (രണ്ട് തവണ) ചോദിക്കും — ഇതാണ് website-ന്റെ login.
പിന്നെ local ആയി test ചെയ്യാൻ:

```
npm start
```

Browser-ൽ http://localhost:8080 തുറക്കുക.

## 2. GitHub-ൽ publish ചെയ്യുക (ഒരു തവണ മാത്രം)

1. Repo: https://github.com/hyzamat/S-A_IT_Support (**Public**)
   (Private repo-ൽ GitHub Pages-ന് paid plan വേണം. Content encrypted ആയതുകൊണ്ട് public പ്രശ്നമില്ല.)
2. ഈ folder-ൽ:

   ```
   git init -b main
   git add -A
   git commit -m "IT Support Toolkit"
   git remote add origin https://github.com/hyzamat/S-A_IT_Support.git
   git push -u origin main
   ```

3. Repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, Folder: **`/docs`** → Save.
4. അതേ page-ൽ **Custom domain**: `itsupport.hizarc.com` → Save.

## 3. DNS — hizarc.com-ൽ subdomain ചേർക്കുക

Domain വാങ്ങിയ സ്ഥലത്തെ (GoDaddy / Namecheap / Hostinger / Cloudflare …) DNS settings-ൽ:

| Type | Name / Host | Value / Target |
|---|---|---|
| `CNAME` | `itsupport` | `hyzamat.github.io` |

- Cloudflare ആണെങ്കിൽ proxy **DNS only** (grey cloud) ആക്കുക.
- 10 മിനിറ്റ് – കുറച്ച് മണിക്കൂർ എടുക്കാം. GitHub Pages settings-ൽ DNS check ✔ ആയാൽ **Enforce HTTPS** tick ചെയ്യുക.
- **HTTPS നിർബന്ധം** — encryption browser-ൽ HTTPS-ൽ മാത്രമേ പ്രവർത്തിക്കൂ.
- Security-ക്ക് (domain takeover തടയാൻ): GitHub → Settings (profile) → Pages → **Add a domain** → `hizarc.com` verify ചെയ്യുക (ഒരു TXT record ചേർക്കാൻ പറയും).

## 4. പുതിയ command / tip ചേർക്കാൻ

`content/` folder-ലെ ഏതെങ്കിലും `.md` file edit ചെയ്യുക (format: `content/_FORMAT-GUIDE.md`):

````
## Flush DNS cache
tags: dns, network
admin: yes

Clears the DNS cache.

```cmd
ipconfig /flushdns
```
````

- `{{host}}` → website-ൽ ഒരു box വരും, value type ചെയ്ത് copy ചെയ്യാം.
- `{{port:443}}` → default value ഉള്ള box.

പിന്നെ:

```
npm run check     (mistakes ഉണ്ടോ എന്ന് നോക്കും)
npm run deploy    (encrypt + commit + GitHub-ലേക്ക് push)
```

ഒന്ന്-രണ്ട് മിനിറ്റിനുള്ളിൽ website update ആകും.
`npm run deploy` ആദ്യം GitHub-ൽ നിന്ന് ഏറ്റവും പുതിയ data എടുക്കും — website-ൽ ചേർത്തവ നഷ്ടപ്പെടില്ല.

## 5. Client PC-യിൽ / phone-ൽ നിന്ന് ചേർക്കാൻ (➕ Add)

Login ചെയ്ത ശേഷം മുകളിലെ **＋ Add** അമർത്തുക → category, title, command, tags → **Save to website**.
ഒരു മിനിറ്റിനുള്ളിൽ site-ൽ വരും. Client PC-യിൽ GitHub login **വേണ്ട** — site-ന്റെ username / password മാത്രം.

**ഒരു തവണ മാത്രം — നിങ്ങളുടെ PC-യിൽ setup:**

1. GitHub-ൽ ഒരു **fine-grained token** ഉണ്ടാക്കുക: https://github.com/settings/personal-access-tokens/new
   - Expiration: ഉദാ. 1 year
   - Repository access → **Only select repositories** → `itsupport` മാത്രം
   - Permissions → Repository permissions → **Contents → Read and write** (വേറെ ഒന്നും വേണ്ട)
   - Generate → token copy ചെയ്യുക
2. ഈ folder-ൽ:

   ```
   npm run setup-editing
   npm run deploy
   ```

   Repo name, branch, token ചോദിക്കും. Token GitHub-ൽ check ചെയ്യും.
   "Keep the token inside the encrypted data?" — **Y** = client PC-യിൽ site login മാത്രം മതി.
   **n** = ഓരോ tab-ലും save ചെയ്യുമ്പോൾ token ചോദിക്കും (കൂടുതൽ safe, പക്ഷേ token type ചെയ്യണം).

**എങ്ങനെ പ്രവർത്തിക്കുന്നു:**

- Token commands-ന്റെ കൂടെ `data.enc.json`-ൽ **encrypt** ചെയ്താണ് വെക്കുന്നത് — GitHub-ൽ plain text ആയി ഇല്ല.
- Site login ചെയ്യുമ്പോൾ മാത്രം browser memory-യിൽ തുറക്കും. Logout / tab close ചെയ്താൽ പോകും.
- Token-ന് ഈ ഒരു repo-യിലെ files മാത്രം മാറ്റാൻ പറ്റും — നിങ്ങളുടെ GitHub account, മറ്റ് repos ഒന്നും തൊടാൻ പറ്റില്ല.
- ചേർത്ത ഓരോ item-ഉം ഒരു പുതിയ file ആയി (`online/…md`) data-യിൽ ചേരും. അടുത്ത തവണ `npm run deploy`
  ചെയ്യുമ്പോൾ അവ `content/online/`-ലേക്ക് copy ആകും. വേണമെങ്കിൽ അവ വേറെ file-ലേക്ക് മാറ്റാം — വീണ്ടും import ആവില്ല.

**⚠ Site password ആർക്കെങ്കിലും കിട്ടിയാൽ** അവർക്ക് edit-ഉം ചെയ്യാം. അപ്പോൾ:
1. GitHub → Settings → Developer settings → Personal access tokens → ആ token **Delete**
2. `npm run build:new` (പുതിയ password) → `npm run deploy`
3. തെറ്റായ മാറ്റങ്ങൾ GitHub-ലെ commit history-ൽ നിന്ന് revert ചെയ്യാം.

Token expire ആയാൽ website "GitHub rejected the token" എന്ന് പറയും → പുതിയ token ഉണ്ടാക്കി `npm run setup-editing` → `npm run deploy`.
Website editing off ചെയ്യാൻ: `npm run setup-editing` → token ചോദിക്കുമ്പോൾ empty ആയി Enter.

## 6. Profile — signed-in sessions, Revoke, Sign out all devices

മുകളിലെ **● username (2)** ബട്ടൺ അമർത്തിയാൽ **Profile** തുറക്കും. അവിടെ:

- **Signed-in sessions** — ഇപ്പോൾ ഏതൊക്കെ browser-കളിൽ login ആണ് (ഉദാ. "Chrome on Windows", login സമയം, "Active now").
  ബട്ടണിലെ number = active sessions-ന്റെ എണ്ണം. "Recently ended" = logout / timeout / revoke ആയവ (7 ദിവസം).
- **Revoke** — മറ്റൊരു session-ന് നേരെ അമർത്തിയാൽ ആ tab ഏകദേശം 1 മിനിറ്റിനുള്ളിൽ സ്വയം logout ആകും.
  (ഉദാ. client PC-യിൽ logout ചെയ്യാൻ മറന്നാൽ.)
- **Sign out all other devices** — password ഒന്നുകൂടി ചോദിക്കും. Content ഒരു **പുതിയ key**-യിൽ വീണ്ടും encrypt ചെയ്യും →
  മറ്റെല്ലാ tabs-ഉം saved sessions-ഉം 1 മിനിറ്റിനുള്ളിൽ പ്രവർത്തിക്കാതാകും.
  **"Also change the password"** tick ചെയ്താൽ password-ഉം അവിടെ വെച്ച് തന്നെ മാറ്റാം (PC ഇല്ലാതെ, phone-ൽ നിന്നും).
  Password മാറ്റിയാൽ PC-യിലെ അടുത്ത `npm run deploy`-ക്കും **പുതിയ** password ആണ് കൊടുക്കേണ്ടത്.

**എങ്ങനെ പ്രവർത്തിക്കുന്നു:** server ഇല്ലാത്തതുകൊണ്ട് session list GitHub repo-യിലെ ഒരു വേറെ branch-ൽ
(`itsupport-sessions` → `sessions.enc.json`) content-ന്റെ അതേ key കൊണ്ട് **encrypt** ചെയ്ത് വെക്കുന്നു. ആ branch
website deploy ചെയ്യില്ല. ഓരോ tab-ഉം login-ൽ register ചെയ്യും, ഉപയോഗിക്കുമ്പോൾ ~5 മിനിറ്റിൽ ഒരിക്കൽ "active" update ചെയ്യും,
ഓരോ മിനിറ്റിലും (tab-ലേക്ക് തിരികെ വരുമ്പോഴും) revoke ആയോ എന്ന് check ചെയ്യും. ➕ Add-ന്റെ അതേ GitHub token ആണ് ഉപയോഗിക്കുന്നത് —
`npm run setup-editing`-ൽ token **keep (Y)** ചെയ്തിട്ടില്ലെങ്കിൽ session list off ആയിരിക്കും.

**പരിമിതികൾ:**

- Password അറിയുന്ന ഒരാൾക്ക് website ഇല്ലാതെ തന്നെ public encrypted file decrypt ചെയ്യാം — അവർ list-ൽ വരില്ല.
  അങ്ങനെ സംശയം തോന്നിയാൽ **Sign out all other devices + Also change the password** ചെയ്യുക.
- Revoke ഇനി ഉപയോഗിക്കുന്നത് മാത്രം തടയും; അതിനുമുമ്പ് ആ tab-ൽ കണ്ടത് തിരിച്ചെടുക്കാൻ പറ്റില്ല.
- Repo public ആയതുകൊണ്ട് `itsupport-sessions` branch-ലെ commit സമയങ്ങൾ ആർക്കും കാണാം (ഉള്ളടക്കം encrypted).
- Client network `api.github.com` block ചെയ്താൽ list update ആകില്ല — site ബാക്കി സാധാരണ പോലെ പ്രവർത്തിക്കും.

## Password മാറ്റാൻ

Website-ൽ: **Profile → Sign out all other devices → Also change the password**. അല്ലെങ്കിൽ PC-യിൽ:

```
npm run build:new
npm run deploy
```

ആദ്യം പഴയ login ചോദിക്കും (website-ൽ ചേർത്തവയും settings-ഉം നിലനിർത്താൻ), പിന്നെ പുതിയത്.
പഴയ password മറന്നുപോയാൽ: `npm run build:new -- --force` (അവസാന deploy-ക്ക് ശേഷം website-ൽ ചേർത്തവയും editing settings-ഉം പോകും).

## പുതിയ PC-യിൽ / content/ folder നഷ്ടപ്പെട്ടാൽ

`content/` GitHub-ൽ ഇല്ല. പക്ഷേ encrypted file-ൽ എല്ലാം ഉണ്ട്:

```
git clone https://github.com/hyzamat/S-A_IT_Support.git
cd S-A_IT_Support
npm run restore
```

Login കൊടുത്താൽ എല്ലാ `.md` files-ഉം `content/`-ലേക്ക് തിരികെ വരും.
(എന്നാലും `content/` folder OneDrive / Google Drive-ൽ ഒരു backup വെക്കുന്നത് നല്ലതാണ്.)

## Client PC-യിൽ ഉപയോഗിക്കുമ്പോൾ

- Browser password save ചെയ്യാൻ ചോദിച്ചാൽ **Never** അമർത്തുക.
- പണി കഴിഞ്ഞാൽ **Log out** അമർത്തുക (clipboard clear ആകും). Win + V clipboard history-ഉം clear ചെയ്യുക.
- Website-ലെ search: `/` അമർത്തിയാൽ search box-ലേക്ക് പോകും, `Esc` clear ചെയ്യും.
- **⬇ .cmd** button (CMD / PowerShell code-ൽ): copy-paste ഇല്ലാതെ run ചെയ്യാൻ. Download ആയ file double-click ചെയ്യുക.
  "Run as admin" items സ്വയം UAC ചോദിക്കും. Run കഴിഞ്ഞ് ഒരു key അമർത്തിയാൽ file **സ്വയം delete** ആകും.
  Browser / SmartScreen "unsafe" എന്ന് warning കാണിച്ചാൽ **Keep** → **More info → Run anyway**.
- **↗ Open** button (`ms-settings:` items-ൽ, Windows-ൽ മാത്രം): ആ Settings page നേരിട്ട് തുറക്കും.
  Browser "Open Settings?" എന്ന് ചോദിക്കും → **Open**. Website-ന് മറ്റ് programs ഒന്നും തുറക്കാൻ പറ്റില്ല.

## Commands

| Command | ചെയ്യുന്നത് |
|---|---|
| `npm run check` | content-ൽ തെറ്റുണ്ടോ എന്ന് നോക്കും (ഒന്നും എഴുതില്ല) |
| `npm run deploy` | GitHub-ൽ നിന്ന് website additions എടുക്കും + build + commit + push (സാധാരണ ഇത് മതി) |
| `npm run build` | build മാത്രം (push ഇല്ല — `npm start` വെച്ച് test ചെയ്യാൻ) |
| `npm run build:new` | പുതിയ username / password set ചെയ്യും |
| `npm run setup-editing` | Website-ലെ **＋ Add** button-ന് GitHub token set ചെയ്യും / off ചെയ്യും |
| `npm start` | http://localhost:8080 ൽ test ചെയ്യാം |
| `npm run restore` | GitHub-ലെ encrypted data-യിൽ നിന്ന് `content/` തിരികെ എടുക്കും |

Build ചെയ്യുമ്പോൾ website-ൽ ഉള്ള ഒരു file `content/`-ൽ ഇല്ലെങ്കിൽ (ഉദാ. അബദ്ധത്തിൽ delete ചെയ്താൽ),
അത് website-ൽ നിന്ന് മാറ്റുന്നതിന് മുമ്പ് ചോദിക്കും.

Requirements: [Node.js](https://nodejs.org) 20+ and [Git](https://git-scm.com).

- Windows: nodejs.org-ൽ നിന്ന് install ചെയ്യുക, അല്ലെങ്കിൽ `winget install OpenJS.NodeJS.LTS Git.Git`
- Mac: `brew install node git` (Homebrew), അല്ലെങ്കിൽ nodejs.org installer
- Linux (Ubuntu): `sudo apt install nodejs npm git` — version 20-ൽ കുറവാണെങ്കിൽ nodejs.org-ലെ instructions നോക്കുക
