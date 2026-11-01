# Better16 Community Wiki

A deployable English-language community wiki with a retro 2020-inspired blue interface.

## Features
- Register and sign in with a username and password
- Change display name and upload a profile avatar
- Publish posts with up to five tags
- Search post titles, post content, tags and users
- Browse tag shortcuts
- Admin-published yellow announcement banner that visitors can dismiss
- Sidebar links to the official download and website
- PostgreSQL database and persistent avatar storage on Render

## Deploy to Render
1. Put this project in a GitHub repository.
2. In Render, choose **New + → Blueprint** and select the repository containing `render.yaml`.
3. Render will create the web service, PostgreSQL database and persistent disk.
4. When prompted, set `ADMIN_USERNAME` and `ADMIN_PASSWORD`. Use a new, strong password. These create the administrator account used to publish announcements.
5. Deploy. Open the web service URL when the deploy is live.

The first deployment may take a few minutes while the database is created.

## Admin announcements
Sign in using the `ADMIN_USERNAME` and `ADMIN_PASSWORD` values entered in Render. An **Admin** button appears in the top bar. Use it to publish the yellow announcement banner.

## Notes
- This is a community-made project, not an official Better16 website or wiki.
- The provided image is used as the site icon and brand artwork.
- The Render blueprint uses a paid web instance, a small paid PostgreSQL plan and a 1 GB persistent disk. Render plan prices can change; check the dashboard before deploying.
- Do not use the default session secret in production. Render generates one automatically through the blueprint.
- Avatar uploads are limited to PNG, JPG, WEBP and GIF, up to 2 MB.
