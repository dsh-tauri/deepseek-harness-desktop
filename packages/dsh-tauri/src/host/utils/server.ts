import type { Context } from '@deepseek-ai/cordis'
import type { HostService } from 'dsh-h3'
import type { H3Event } from 'h3'
import { getServerContext as contextOf } from 'dsh-h3/utils'

export const getServerContext = contextOf as <Host = Context>(source: HostService<any> | H3Event) => Host
