# Getting started with AI Office

AI Office is a small office of AI employees that runs on your own computer. You set it up in a browser wizard. You do not edit any files, and you do not need any developer tools besides Docker.

## What you need

- A computer with Docker Desktop (Mac or Windows) or Docker Engine (Linux), amd64 or arm64.
- About 4 GB of free disk space for the image (it is about 3.7 GB), plus room for your files.
- A ChatGPT subscription. The AI employees run on Codex with your subscription. Each task uses your plan's allowance.

## 1. Start the office

Open a terminal and run this one line. Replace `VERSION` with the latest version on the [package page](https://github.com/orgs/EarthLinkNetwork/packages/container/package/aioffice) (for example `0.1.0`). The first start takes a minute or two; if a wizard step says "The office is still starting. Wait a moment and reload.", do that.

```sh
docker run -d --name aioffice --stop-timeout 60 -p 127.0.0.1:3100:3100 -v aioffice:/data ghcr.io/earthlinknetwork/aioffice:VERSION
```

The office keeps everything in the `aioffice` volume. Removing the container does not remove your data.

## 2. Open the wizard

Open this address in your browser:

```text
http://localhost:3100/
```

The wizard has eight short steps.

1. **Language** — English or Japanese. You can change it later.
2. **Owner password** — only someone with this password, in this browser, can open the office.
3. **Company name** — the name of your office.
4. **Choose your AI** — pick the AI services your AI employees use (for example ChatGPT or Claude) and connect each one with your own subscription: download it, open the sign-in link, and enter or paste the code. You can use more than one and choose per employee. You can also connect later from **AI subscriptions** in the office, but the AI employees do not work until you connect.
5. **Secretary** — your first AI employee. You talk to the secretary, and it passes work to the other desks.
6. **More AI employees** — pick any desks you want now. You can add more later.
7. **Your files** — pick a folder. The `.md` and `.txt` files in it go into the library so your AI employees can search them. You can skip this.
8. **Done** — open the office. The screens after this (Paperclip, the app the office runs on) are in English.

## 3. Use the office

Click a room to see what you can do there. For example, the library searches your files, and the design room makes logos and flyers. If you did not add a design employee in step 6, the design room has a button to add one.

## Update to a new version

Run this line with the new version. Your data stays, and the wizard does not show again (a different browser asks for the owner password). On Windows PowerShell 5.1, which does not accept `&&`, run the four commands one at a time.

```sh
docker stop aioffice && docker rm aioffice && docker pull ghcr.io/earthlinknetwork/aioffice:VERSION && docker run -d --name aioffice --stop-timeout 60 -p 127.0.0.1:3100:3100 -v aioffice:/data ghcr.io/earthlinknetwork/aioffice:VERSION
```

## Forgot the owner password

```sh
docker exec aioffice aioffice-reset-owner
```

Then open http://localhost:3100/ again and choose a new password.
