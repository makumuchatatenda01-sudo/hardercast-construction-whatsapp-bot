# Hardercast Construction WhatsApp Bot

WhatsApp automation bot for Hardercast Construction.

## Production details

- Bot name: Hardercast Construction
- Production path: `/opt/VisionCo_Bots/hardercast-construction`
- PM2 app: `vision-hardercast-construction`
- Port: `4120`
- Domain: `https://hardercast.visionpixels.autos`
- Webhook: `/webhooks/hardercast-construction`

## Main behaviour

This bot handles WhatsApp customer enquiries and guides users through the Hardercast Construction service flow.

## Important security note

Do not commit:

- `.env`
- WhatsApp auth/session folders
- logs
- node_modules
- backups
- private keys
