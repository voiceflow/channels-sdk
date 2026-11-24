// Written by scripts/channels.mjs: change the template there, not this file.
// A Voiceflow agent in GitHub, end to end on this machine: Chat SDK's real
// GitHub adapter and the core's agent, against a stand-in for GitHub
// (./stand-in.mjs) and a scripted Voiceflow runtime. Every channel runs the
// same conversation.
import { createMemoryState } from '@chat-adapter/state-memory';
import { channelContract } from '@voiceflow/channelkit/testing';
import * as commands from '../dist/connect/index.js';
import { CONTEXT_VARIABLES, github } from '../dist/index.js';
import { start } from './stand-in.mjs';

channelContract({ slug: 'github', channel: github, variables: CONTEXT_VARIABLES, commands, start, state: createMemoryState });
