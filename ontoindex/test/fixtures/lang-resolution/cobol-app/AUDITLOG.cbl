       IDENTIFICATION DIVISION.
       PROGRAM-ID. AUDITLOG.

       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-LOG-MESSAGE           PIC X(80).
       01 WS-TIMESTAMP             PIC X(26).

       LINKAGE SECTION.
       01 LS-CUST-ID               PIC 9(8).
       01 LS-AMOUNT                PIC 9(7)V99.

       PROCEDURE DIVISION USING LS-CUST-ID LS-AMOUNT.
       MAIN-PARAGRAPH.
           PERFORM WRITE-LOG
           GOBACK.

       WRITE-LOG.
           STRING 'Customer ' LS-CUST-ID ' amount ' LS-AMOUNT
               DELIMITED BY SIZE INTO WS-LOG-MESSAGE
           DISPLAY WS-LOG-MESSAGE.

       ENTRY "AUDITLOG-BATCH" USING LS-CUST-ID.
           DISPLAY 'Batch audit for ' LS-CUST-ID
           GOBACK.
