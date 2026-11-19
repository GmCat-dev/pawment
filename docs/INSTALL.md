# Installing Pawment on a server

> **Beta software, still under development.** Test with small amounts first, and check payments in your own wallet too.

This guide uses Ubuntu 24.04 with Nginx, but any Linux with Node.js 22.13+ works. Pawment needs very little: about
60 MB of memory, no database server and no blockchain node.

## 1. Node.js and the code
    sudo apt update && sudo apt install -y nginx git
    # Node.js 22 or newer (NodeSource, nvm, or your distribution's package if it is new enough)
    node --version                                      # must say v22.13 or later

    sudo git clone https://github.com/GmCat-dev/pawment /opt/pawment
    cd /opt/pawment && sudo npm install --omit=dev      # the Cardano "Pay" button library (optional)

## 2. A data folder and settings
Pawment keeps its database, secrets and editable settings in one folder, owned by the user it runs as.

    sudo mkdir -p /var/lib/pawment
    sudo cp /opt/pawment/settings.example.json /var/lib/pawment/settings.json
    sudo chown -R www-data:www-data /var/lib/pawment && sudo chmod 700 /var/lib/pawment
    sudo -u www-data nano /var/lib/pawment/settings.json

Change at least:
- `"name"`: your shop's name, shown on the checkout
- `"public_url"`: the address people will use, e.g. `"https://pay.example.com"`
- `"network"`: `"testnet"` to try it first, `"mainnet"` for real payments

The other settings are explained in [SETTINGS.md](SETTINGS.md). Most can also be changed later in the dashboard.

## 3. Secrets
Run these as the service user so the files belong to it (here `www-data`):

    cd /opt/pawment
    sudo -u www-data env PAY_DATA=/var/lib/pawment node cli.mjs init
    echo 'a long dashboard password' | sudo -u www-data env PAY_DATA=/var/lib/pawment node cli.mjs password
    sudo -u www-data env PAY_DATA=/var/lib/pawment node cli.mjs add-site myshop

- `init` writes the **admin key** to `/var/lib/pawment/admin-key.txt` (for scripts and other owner tools; the dashboard uses the password).
- `add-site` writes the site's **API key** and **webhook secret** to `/var/lib/pawment/site-myshop.txt`. Copy them into your shop, then delete that file.

Nothing secret is ever printed to the screen.

## 4. Run it as a service
`/etc/systemd/system/pawment.service` (a copy is in `deploy/pawment.service`):

    [Unit]
    Description=Pawment (watch-only crypto checkout)
    After=network.target

    [Service]
    ExecStart=/usr/bin/node /opt/pawment/server.mjs
    Environment=PAY_DATA=/var/lib/pawment
    Environment=PAY_SETTINGS=/var/lib/pawment/settings.json
    Environment=PAY_PORT=4201
    User=www-data
    Group=www-data
    Restart=on-failure
    NoNewPrivileges=true
    ProtectSystem=strict
    ProtectHome=true
    PrivateTmp=true
    ReadWritePaths=/var/lib/pawment

    [Install]
    WantedBy=multi-user.target

Check `which node` and fix the `ExecStart` path if it differs. Then:

    sudo systemctl daemon-reload && sudo systemctl enable --now pawment
    curl -s http://127.0.0.1:4201/api/health      # {"ok":true,...}

## 5. Nginx and HTTPS
Do this in two steps, because Nginx refuses to start with a certificate that doesn't exist yet.

**Step A: port 80 only, to get the certificate.** Create `/etc/nginx/sites-available/pawment` with just this:

    server {
        listen 80;
        server_name pay.example.com;
        location ^~ /.well-known/acme-challenge/ { root /var/www/html; }
        location / { return 301 https://$host$request_uri; }
    }

Then:

    sudo ln -s /etc/nginx/sites-available/pawment /etc/nginx/sites-enabled/
    sudo nginx -t && sudo systemctl reload nginx
    sudo apt install -y certbot && sudo certbot certonly --webroot -w /var/www/html -d pay.example.com

**Step B: add the HTTPS block** below the first one in the same file (the full file is in `deploy/nginx-example.conf`):

    server {
        listen 443 ssl;
        server_name pay.example.com;
        ssl_certificate     /etc/letsencrypt/live/pay.example.com/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/pay.example.com/privkey.pem;
        add_header Strict-Transport-Security "max-age=31536000" always;
        client_max_body_size 640k;
        location / {
            proxy_pass http://127.0.0.1:4201;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_read_timeout 60s;
        }
    }

Then check and reload again:

    sudo nginx -t && sudo systemctl reload nginx

`X-Forwarded-Proto` matters: Pawment marks its cookies Secure only when it knows the visit is HTTPS.

## 6. First visit
Open `https://pay.example.com/admin/` and sign in with your password. Then:

1. **Wallet** tab: give a public key or address for each coin family you want (see [WALLETS.md](WALLETS.md)). Check that the
   addresses it shows match your wallet app before saving.
2. **Settings**: your alert email (needs a Resend key for sending), optional Koios token and Blockfrost project id for Cardano.
3. **Coins & discounts**: switch coins on or off, set the order and any discounts.
4. **Try a $1 checkout**: on the test network first. Pay it from a test wallet and watch it turn paid.

## 7. Connect your shop
See [API.md](API.md): create an order from your server, send the buyer to `checkout_url`, and mark the order paid when the
signed `order.paid` notice arrives (or when `GET /api/orders/<id>` says `paid`).

## Keeping it running
- **Backups:** copy `/var/lib/pawment` somewhere safe every day. It holds the database (`pay.db`), your settings and secrets.
- **Updates:** `cd /opt/pawment && sudo git pull && sudo npm install --omit=dev && sudo systemctl restart pawment`. Read the release notes first while Pawment is in beta.
- **Logs:** `journalctl -u pawment -f`.
- **Going live:** switch `"network"` to `"mainnet"`, set your real wallets again (test-network keys don't work on mainnet), and do one small real payment per coin you take.
