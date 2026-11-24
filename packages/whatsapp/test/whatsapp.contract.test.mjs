// Written by scripts/channels.mjs: change the template there, not this file.
// A Voiceflow agent in WhatsApp Business Cloud, end to end on this machine: Chat SDK's real
// WhatsApp Business Cloud adapter and the core's agent, against a stand-in for WhatsApp Business Cloud
// (./stand-in.mjs) and a scripted Voiceflow runtime. Every channel runs the
// same conversation.
import { createMemoryState } from '@chat-adapter/state-memory';
import { channelContract } from '@voiceflow/channelkit/testing';
import * as commands from '../dist/connect/index.js';
import { CONTEXT_VARIABLES, whatsapp } from '../dist/index.js';
import { start } from './stand-in.mjs';

channelContract({ slug: 'whatsapp', channel: whatsapp, variables: CONTEXT_VARIABLES, commands, start, state: createMemoryState });
