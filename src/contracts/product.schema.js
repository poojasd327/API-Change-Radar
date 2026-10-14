/**
 * Approved JSON Schema contract for Product response.
 *
 * Rules:
 * - Must be a JSON Object.
 * - Required fields: 'id', 'name', 'price'.
 * - 'id': must be an integer.
 * - 'name': must be a string.
 * - 'price': must be a number (float or integer).
 * - 'additionalProperties: false': strictly forbids any undeclared fields
 *   so that unforeseen fields (or leaking internal fields) are flagged.
 */
const productSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Product',
  type: 'object',
  required: ['id', 'name', 'price'],
  additionalProperties: false,
  properties: {
    id: {
      type: 'integer',
      description: 'Unique numeric identifier of the product'
    },
    name: {
      type: 'string',
      description: 'Product display name'
    },
    price: {
      type: 'number',
      description: 'Product price in currency units'
    }
  }
};

module.exports = {
  productSchema
};
