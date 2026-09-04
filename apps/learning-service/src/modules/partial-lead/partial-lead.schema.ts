export interface SavePartialLeadInput {
  id?: string;
  studentName: string;
  studentGrade: string;
  dialCode?: string;
  phone: string;
  email: string;
  hasLaptop?: boolean;
  preferredSlotDate?: string;
  preferredSlotTime?: string;
  parentName?: string;
  whoAreYou?: string;
  bookingReason?: string;
  purchaseTimeline?: string;
}

export interface CompletePartialLeadInput {
  id?: string;
  studentName: string;
  studentGrade: string;
  dialCode?: string;
  phone: string;
  email: string;
  hasLaptop?: boolean;
  preferredSlotDate?: string;
  preferredSlotTime?: string;
  parentName: string;
  whoAreYou?: string;
  bookingReason?: string;
  purchaseTimeline?: string;
}

export function validateSavePartialLead(body: any): SavePartialLeadInput {
  if (!body || typeof body !== 'object') {
    throw new Error('Invalid request payload');
  }
  if (!body.phone || typeof body.phone !== 'string' || !body.phone.trim()) {
    throw new Error('Phone number is required');
  }
  if (!body.studentName || typeof body.studentName !== 'string' || !body.studentName.trim()) {
    throw new Error("Student's full name is required");
  }

  return {
    id: body.id ? String(body.id) : undefined,
    studentName: String(body.studentName).trim(),
    studentGrade: String(body.studentGrade || 'Grade 6').trim(),
    dialCode: String(body.dialCode || '+91').trim(),
    phone: String(body.phone).trim(),
    email: String(body.email || '').trim(),
    hasLaptop: body.hasLaptop !== undefined ? Boolean(body.hasLaptop) : true,
    preferredSlotDate: body.preferredSlotDate ? String(body.preferredSlotDate).trim() : undefined,
    preferredSlotTime: body.preferredSlotTime ? String(body.preferredSlotTime).trim() : undefined,
    parentName: body.parentName ? String(body.parentName).trim() : undefined,
    whoAreYou: body.whoAreYou ? String(body.whoAreYou).trim() : undefined,
    bookingReason: body.bookingReason ? String(body.bookingReason).trim() : undefined,
    purchaseTimeline: body.purchaseTimeline ? String(body.purchaseTimeline).trim() : undefined,
  };
}
