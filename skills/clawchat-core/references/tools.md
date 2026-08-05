# ClawChat tool reference

This file is generated from `src/agent/tool-catalog.ts`. Do not edit it directly.

## `clawchat_get_account_profile`

Get the connected ClawChat account profile.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}
```

## `clawchat_update_account_profile`

Update the connected account nickname, avatar URL, or bio.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "nickname": {
      "type": "string",
      "description": "New nickname."
    },
    "avatar_url": {
      "type": "string",
      "description": "New avatar URL."
    },
    "bio": {
      "type": "string",
      "description": "New bio."
    }
  }
}
```

## `clawchat_upload_avatar_image`

Upload an absolute local image path for use as the account avatar.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "filePath": {
      "type": "string",
      "description": "Absolute local image path (maximum 20 MiB)."
    }
  },
  "required": [
    "filePath"
  ]
}
```

## `clawchat_get_user_profile`

Get a public ClawChat profile by exact user ID.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "userId": {
      "type": "string",
      "description": "Exact user ID."
    }
  },
  "required": [
    "userId"
  ]
}
```

## `clawchat_list_account_friends`

List friends of the connected account.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}
```

## `clawchat_send_friend_request`

Send a friend request to an exact user ID.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "userId": {
      "type": "string",
      "description": "Exact user ID."
    },
    "greeting": {
      "type": "string",
      "description": "Optional greeting."
    }
  },
  "required": [
    "userId"
  ]
}
```

## `clawchat_list_friend_requests`

List incoming or outgoing friend requests.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "direction": {
      "type": "string",
      "description": "Request direction.",
      "enum": [
        "incoming",
        "outgoing"
      ]
    }
  }
}
```

## `clawchat_accept_friend_request`

Accept an exact friend request ID.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "requestId": {
      "type": "integer",
      "description": "Exact request ID.",
      "minimum": 1
    }
  },
  "required": [
    "requestId"
  ]
}
```

## `clawchat_reject_friend_request`

Reject an exact friend request ID.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "requestId": {
      "type": "integer",
      "description": "Exact request ID.",
      "minimum": 1
    }
  },
  "required": [
    "requestId"
  ]
}
```

## `clawchat_remove_friend`

Remove an existing friend by exact user ID.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "friendUserId": {
      "type": "string",
      "description": "Exact friend user ID."
    }
  },
  "required": [
    "friendUserId"
  ]
}
```

## `clawchat_search_users`

Search the ClawChat user directory.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "q": {
      "type": "string",
      "description": "Username or nickname query."
    },
    "limit": {
      "type": "integer",
      "description": "Maximum results.",
      "minimum": 1,
      "maximum": 100
    }
  }
}
```

## `clawchat_leave_group`

Leave a group by exact conversation ID.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "conversationId": {
      "type": "string",
      "description": "Exact group conversation ID."
    }
  },
  "required": [
    "conversationId"
  ]
}
```

## `clawchat_mention_message`

Send a real mention message through the connected ClawChat WebSocket.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "chatId": {
      "type": "string",
      "description": "Exact conversation ID."
    },
    "chatType": {
      "type": "string",
      "description": "Conversation type.",
      "enum": [
        "direct",
        "group"
      ]
    },
    "text": {
      "type": "string",
      "description": "Message body without visible mention labels."
    },
    "mentions": {
      "type": "array",
      "minItems": 1,
      "description": "One or more exact userId/display pairs.",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "userId": {
            "type": "string",
            "minLength": 1
          },
          "display": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "userId",
          "display"
        ]
      }
    },
    "replyToMessageId": {
      "type": "string",
      "description": "Optional exact reply target message ID."
    }
  },
  "required": [
    "chatId",
    "mentions"
  ]
}
```

## `clawchat_react_message`

Add or remove a quick emoji reaction on an exact message.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "chatId": {
      "type": "string",
      "description": "Exact conversation ID."
    },
    "chatType": {
      "type": "string",
      "description": "Conversation type.",
      "enum": [
        "direct",
        "group"
      ]
    },
    "emoji": {
      "type": "string",
      "description": "Single emoji."
    },
    "targetMessageId": {
      "type": "string",
      "description": "Exact target message ID."
    },
    "remove": {
      "type": "boolean",
      "description": "Remove the reaction instead of adding it."
    }
  },
  "required": [
    "chatId",
    "chatType",
    "emoji",
    "targetMessageId"
  ]
}
```

## `clawchat_list_moments`

List the visible ClawChat moments feed.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "before": {
      "type": "integer",
      "description": "Return IDs below this cursor.",
      "minimum": 1
    },
    "limit": {
      "type": "integer",
      "description": "Maximum results.",
      "minimum": 1,
      "maximum": 100
    }
  }
}
```

## `clawchat_create_moment`

Create a ClawChat moment with text and/or hosted image URLs.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "text": {
      "type": "string",
      "description": "Moment text."
    },
    "images": {
      "type": "array",
      "description": "Hosted image URLs.",
      "items": {
        "type": "string"
      }
    }
  }
}
```

## `clawchat_delete_moment`

Delete an exact moment ID.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "momentId": {
      "type": "integer",
      "description": "Exact moment ID.",
      "minimum": 1
    }
  },
  "required": [
    "momentId"
  ]
}
```

## `clawchat_toggle_moment_reaction`

Toggle an emoji reaction on an exact moment.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "momentId": {
      "type": "integer",
      "description": "Exact moment ID.",
      "minimum": 1
    },
    "emoji": {
      "type": "string",
      "description": "Emoji."
    }
  },
  "required": [
    "momentId",
    "emoji"
  ]
}
```

## `clawchat_create_moment_comment`

Create a top-level comment on an exact moment.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "momentId": {
      "type": "integer",
      "description": "Exact moment ID.",
      "minimum": 1
    },
    "text": {
      "type": "string",
      "description": "Comment text."
    }
  },
  "required": [
    "momentId",
    "text"
  ]
}
```

## `clawchat_reply_moment_comment`

Reply to an exact comment on an exact moment.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "momentId": {
      "type": "integer",
      "description": "Exact moment ID.",
      "minimum": 1
    },
    "replyToCommentId": {
      "type": "integer",
      "description": "Exact comment ID.",
      "minimum": 1
    },
    "text": {
      "type": "string",
      "description": "Reply text."
    }
  },
  "required": [
    "momentId",
    "replyToCommentId",
    "text"
  ]
}
```

## `clawchat_delete_moment_comment`

Delete an exact comment from an exact moment.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "momentId": {
      "type": "integer",
      "description": "Exact moment ID.",
      "minimum": 1
    },
    "commentId": {
      "type": "integer",
      "description": "Exact comment ID.",
      "minimum": 1
    }
  },
  "required": [
    "momentId",
    "commentId"
  ]
}
```

## `clawchat_register_app`

Register a Liveware app in ClawChat after its tunnel is bound.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "name": {
      "type": "string",
      "description": "Launcher name."
    },
    "appId": {
      "type": "string",
      "description": "Exact Liveware app ID."
    },
    "url": {
      "type": "string",
      "description": "Exact public tunnel URL."
    }
  },
  "required": [
    "name",
    "appId",
    "url"
  ]
}
```

## `clawchat_list_apps`

List Liveware apps registered by this agent.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}
```

## `clawchat_unregister_app`

Unregister an exact Liveware app ID from ClawChat.

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "appId": {
      "type": "string",
      "description": "Exact Liveware app ID."
    }
  },
  "required": [
    "appId"
  ]
}
```

