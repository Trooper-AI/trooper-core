export function withGatewayAttachments(params = {}, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return params;
  return { ...params, attachments };
}
