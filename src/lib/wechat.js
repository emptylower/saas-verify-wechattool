import crypto from 'node:crypto';

const XML_FIELDS = ['ToUserName', 'FromUserName', 'MsgType', 'Content', 'MsgId', 'Event'];

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function verifyWeChatSignature({ token, signature, timestamp, nonce }) {
  const digest = crypto
    .createHash('sha1')
    .update([token, timestamp, nonce].sort().join(''), 'utf8')
    .digest('hex');

  return digest === signature;
}

export function parseWeChatXml(xml) {
  const result = {};

  for (const field of XML_FIELDS) {
    const cdataPattern = new RegExp(`<${field}><!\\[CDATA\\[(.*?)\\]\\]><\\/${field}>`, 's');
    const textPattern = new RegExp(`<${field}>(.*?)<\\/${field}>`, 's');
    const cdataMatch = xml.match(cdataPattern);
    const textMatch = xml.match(textPattern);

    result[field] = (cdataMatch?.[1] ?? textMatch?.[1] ?? '').trim();
  }

  return {
    toUserName: result.ToUserName,
    fromUserName: result.FromUserName,
    messageType: result.MsgType,
    content: result.Content,
    messageId: result.MsgId || null,
    event: result.Event || null
  };
}

export function buildWeChatTextResponse({ toUserName, fromUserName, content }) {
  const now = Math.floor(Date.now() / 1000);

  return `<xml>
<ToUserName><![CDATA[${escapeXml(toUserName)}]]></ToUserName>
<FromUserName><![CDATA[${escapeXml(fromUserName)}]]></FromUserName>
<CreateTime>${now}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${escapeXml(content)}]]></Content>
</xml>`;
}
