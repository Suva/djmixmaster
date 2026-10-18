# Reporting issues

DJ Mix Master is free software, made in the open on [GitHub](https://github.com/Suva/djmixmaster).

## Something wrong

Open an issue on the [issues page](https://github.com/Suva/djmixmaster/issues). It helps to say:

- the version (in Settings) and your system;
- what you did, what you expected, and what happened instead;
- for a problem with a recording, its format and length, and what its check-up says;
- for a problem with a video, the template, or the template file itself.

## Something missing

Ideas are welcome on the same [issues page](https://github.com/Suva/djmixmaster/issues): say what you are trying to do, rather than only how. Ideas already on the list are in [TASKS.md](https://github.com/Suva/djmixmaster/blob/main/TASKS.md).

## Changing it yourself

Pull requests are welcome. You need [Node](https://nodejs.org) 24 or newer and ffmpeg (`brew install ffmpeg` on a Mac):

```
git clone https://github.com/Suva/djmixmaster.git
cd djmixmaster
npm install
npm start
```

[AGENTS.md](https://github.com/Suva/djmixmaster/blob/main/AGENTS.md) explains how the code is put together and how to check a change; run `npm test` before sending one. A change someone would notice goes in [CHANGELOG.md](https://github.com/Suva/djmixmaster/blob/main/CHANGELOG.md), and in this manual: its pages are in `site/manual/`.
