# Getting started with AI Office

AI Office is a small office of AI employees that runs on your own computer. You set it up in a browser wizard. You do not edit any files, and you do not need any developer tools besides Docker.

It is made for three ways of use: just you on this computer, you and your colleagues on your company network, or just you from outside through Cloudflare Tunnel. It is not made to be open to anyone on the internet.

## What you need

- A computer with Docker Desktop (Mac or Windows) or Docker Engine (Linux), amd64 or arm64.
- About 4 GB of free disk space for the image (it is about 3.7 GB), plus room for your files.
- A ChatGPT subscription. The AI employees run on Codex with your subscription. Each task uses your plan's allowance.

## 1. Start the office

Open a terminal and run this one line. Replace `VERSION` with the latest version on the [package page](https://github.com/orgs/EarthLinkNetwork/packages/container/package/aioffice) (for example `0.1.0`). Do not pick a tag that ends in `-amd64` or `-arm64`; docker picks the right one for your computer. The first start takes a minute or two; if a wizard step says "The office is still starting. Wait a moment and reload.", do that.

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
2. **Owner account** — create the owner's account (name, email and password). The first time, the wizard asks for a one-time code that only the person who started the container can see: run `docker logs aioffice` and copy the code on the line `first-owner code`.
3. **Company name** — the name of your office.
4. **Choose your AI** — pick the AI services your AI employees use (for example ChatGPT or Claude) and connect each one with your own subscription: download it, open the sign-in link, and enter or paste the code. You can use more than one and choose per employee. You can also connect later from **AI subscriptions** in the office, but the AI employees do not work until you connect.
5. **Secretary** — your first AI employee. You talk to the secretary, and it passes work to the other desks.
6. **More AI employees** — pick any desks you want now. You can add more later.
7. **Your files** — pick a folder. The `.md` and `.txt` files in it go into the library so your AI employees can search them. You can skip this.
8. **Done** — open the office. The screens after this (Paperclip, the app the office runs on) are in English.

## 3. Use the office

Click a room to see what you can do there. For example, the library searches your files, and the design room makes logos and flyers. If you did not add a design employee in step 6, the design room has a button to add one.

## Update to a new version

Run this line with the new version. Your data stays, and the wizard does not show again (a different browser asks you to sign in). If you update from a version that used an owner password, the office asks for that password once, takes a backup, and moves the office to an owner account: create the account, and the issues assigned to the old owner move to you. Do this move on this computer at http://localhost:3100/ first. Until it is done, other computers and the Cloudflare address are refused. If you started the office with `AIOFFICE_HOSTS` (other computers or Cloudflare Tunnel), use the same `-p` and `-e AIOFFICE_HOSTS=...` in the line. On Windows PowerShell 5.1, which does not accept `&&`, run the four commands one at a time.

```sh
docker stop aioffice && docker rm aioffice && docker pull ghcr.io/earthlinknetwork/aioffice:VERSION && docker run -d --name aioffice --stop-timeout 60 -p 127.0.0.1:3100:3100 -v aioffice:/data ghcr.io/earthlinknetwork/aioffice:VERSION
```

To go back after an update, run this line to list the backups, then run it again with the file you want (`docker exec aioffice aioffice-restore <file>`). After that, restart with `docker restart aioffice`.

```sh
docker exec aioffice aioffice-restore
```

## Invite people

In the office, the owner opens **People**, presses **Invite**, and sends the link to the person. They create their own account with it. The owner sets each person's title and boss; approvals go up this chain and come back.

If the owner has turned on email notices and has confirmed a person's email in People, that person gets one email from the owner's Gmail when something is routed to them.

Invite colleagues in your company. The AI employees work with the owner's access, so a person you invite can, through them, do what the owner can do (change settings, read the connected accounts). This is the same as letting a colleague use the office's shared AI staff.

## Use it from other computers

With the first start line, the office opens only on this computer. To use it from other computers on your company network, remove the container (your data stays in the volume) and start it again with this line. Replace `office-pc.local` with this computer's name or IP address. On other computers, open `http://office-pc.local:3100/`.

```sh
docker run -d --name aioffice --stop-timeout 60 -p 3100:3100 -e AIOFFICE_HOSTS=office-pc.local:3100 -v aioffice:/data ghcr.io/earthlinknetwork/aioffice:VERSION
```

From other computers the office uses plain http, so passwords cross your company network unencrypted. Use this only inside your company network. To reach the office from outside, use Cloudflare Tunnel below instead of opening a port.

## Use it from outside, just for you (Cloudflare Tunnel)

Cloudflare Tunnel gives the office an https address without opening any port on your router. You need a Cloudflare account and a domain on it.

1. In Cloudflare Zero Trust, create a tunnel, add a public hostname such as `office.example.com`, and set its service to type **HTTP**, URL `localhost:3100`. Run the `cloudflared` connector it shows on this computer.
2. In Cloudflare Zero Trust, add an Access application for `office.example.com` that allows only your own email. Then only you can reach the sign-in page.
3. Start the office with the https address. The `127.0.0.1:` part keeps port 3100 closed to your network.

```sh
docker run -d --name aioffice --stop-timeout 60 -p 127.0.0.1:3100:3100 -e AIOFFICE_HOSTS=https://office.example.com -v aioffice:/data ghcr.io/earthlinknetwork/aioffice:VERSION
```

Open `https://office.example.com/`. You can list several addresses in `AIOFFICE_HOSTS`, separated by commas, for example `https://office.example.com,office-pc.local:3100`.

## Forgot the owner password

```sh
docker exec aioffice aioffice-reset-owner
```

It prints a link. Open it and create a new owner account, then sign in at http://localhost:3100/ with it. If you use the office through Cloudflare Tunnel, the command also prints the same link with your https address, and you can open that one instead. Your company, AI employees and settings stay.

Until the new owner signs in, the office pauses the AI employees' scheduled work. Messages from connected channels such as Slack can still wake an AI employee, so AI usage (and its cost) can continue during that time if someone asks for work.
