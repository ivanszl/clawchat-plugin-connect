# Keep Connect Client messages local

Connect Client will observe messages received from ClawChat but will not publish Client-originated messages back to ClawChat. Both origins use the current Session's Runtime Thread, making the Client Transcript the complete context while ClawChat exposes only ClawChat-originated turns; this avoids requiring a separately authenticated ClawChat user solely for message mirroring and keeps ClawChat available as a remote channel.
