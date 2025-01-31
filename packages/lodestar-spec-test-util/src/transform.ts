/* eslint-disable @typescript-eslint/no-explicit-any */
import {Type, UintType, BigIntUintType, byteType, isCompositeType} from "@chainsafe/ssz";

/**
 * Transform the type to something that is safe to deserialize
 *
 * This mainly entails making sure all numbers are bignumbers
 */
export function safeType(type: Type<any>): Type<any> {
  if (type === byteType) {
    return type;
  } else if (!isCompositeType(type)) {
    if ((type as UintType<any>).byteLength) {
      return new BigIntUintType({byteLength: (type as UintType<any>).byteLength});
    } else {
      return type;
    }
  } else {
    const props = Object.getOwnPropertyDescriptors(type) as any;
    if (props.elementType) {
      if (props.elementType.byteLength !== 1) {
        props.elementType.value = safeType(props.elementType.value);
      }
    }
    if (props.fields) {
      for (const fieldName of Object.keys(props.fields.value)) {
        props.fields.value[fieldName] = safeType(props.fields.value[fieldName]);
      }
    }
    const newtype = Object.create(Object.getPrototypeOf(type), props);
    newtype.structural._type = newtype;
    newtype.tree._type = newtype;
    return newtype;
  }
}
